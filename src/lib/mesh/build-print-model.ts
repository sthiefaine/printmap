import Module, {
  type CrossSection,
  type Manifold,
  type ManifoldToplevel,
  type Vec3,
} from "manifold-3d";
import type {
  PrintInput,
  PrintLayer,
  PrintMesh,
  PrintModel,
  PrintProgress,
  PrintTile,
} from "@/types/print";
import { PRINT_LAYERS } from "@/types/print";
import type { Point2D, Polygon2D } from "@/types/geometry";
import type { ElevationGrid } from "@/types/osm";
import { createProjectionForBbox } from "../projection";
import { sampleElevation } from "../elevation/sample-grid";
import {
  parseElements,
  type BuildingData,
  type RoadData,
} from "../osm/parse-elements";
import { simplifyPolyline } from "../polygon/simplify";
import { pointInPolygon } from "../polygon/point-in-polygon";

let runtime: Promise<ManifoldToplevel> | undefined;
async function getRuntime(): Promise<ManifoldToplevel> {
  runtime ??= Module(
    typeof self === "undefined"
      ? undefined
      : { locateFile: () => "/manifold.wasm" },
  ).then((cad) => {
    cad.setup();
    return cad;
  });
  return runtime;
}

/** WASM handles need explicit deletion, including the results of transforms. */
class Arena {
  handles: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }
  dispose(): void {
    for (let i = this.handles.length - 1; i >= 0; i--) this.handles[i].delete();
  }
}

function validateInput(input: PrintInput): void {
  const { bbox, scale, settings } = input;
  if (
    bbox.some((v) => !Number.isFinite(v)) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    bbox[0] < -85 ||
    bbox[2] > 85
  ) {
    throw new Error("La zone sélectionnée est invalide.");
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 500000)
    throw new Error("L’échelle est invalide.");
  const print = settings.print;
  if (
    !print ||
    ![
      print.minFeatureMm,
      print.minBuildingAreaMm2,
      print.minBuildingHeightMm,
      print.simplifyMm,
    ].every(Number.isFinite) ||
    print.minFeatureMm < 0.15 ||
    print.minFeatureMm > 5 ||
    print.minBuildingAreaMm2 < 0 ||
    print.minBuildingHeightMm <= 0 ||
    print.simplifyMm < 0 ||
    print.simplifyMm > 1
  )
    throw new Error("Le profil d’impression est invalide.");
  if (
    !Number.isFinite(settings.base.basePlateThicknessMm) ||
    settings.base.basePlateThicknessMm < 1 ||
    settings.base.basePlateThicknessMm > 20
  ) {
    throw new Error("Le socle doit mesurer entre 1 et 20 mm.");
  }
  const { cols, rows } = settings.base.grid;
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 5 ||
    rows > 5
  )
    throw new Error("La grille est invalide.");
}

interface Terrain {
  solid: Manifold;
  surfaceAt: (x: number, y: number) => number;
  gridVertices: Point2D[];
  gridEdges: [Point2D, Point2D][];
  maxZ: number;
}

function validElevation(grid: ElevationGrid | null): grid is ElevationGrid {
  return (
    !!grid &&
    Number.isInteger(grid.rows) &&
    Number.isInteger(grid.cols) &&
    grid.rows >= 2 &&
    grid.cols >= 2 &&
    grid.rows <= 256 &&
    grid.cols <= 256 &&
    grid.points.length === grid.rows * grid.cols &&
    grid.points.every(Number.isFinite) &&
    grid.north > grid.south &&
    grid.east > grid.west &&
    Number.isFinite(grid.minElev)
  );
}

/** A single indexed watertight terrain solid; all feature surfaces use this same mesh. */
function makeTerrain(
  cad: ManifoldToplevel,
  arena: Arena,
  input: PrintInput,
  width: number,
  depth: number,
): Terrain {
  const { settings, bbox, scale } = input;
  const base = settings.base.basePlateThicknessMm;
  const grid =
    settings.base.topographyEnabled && validElevation(input.elevationGrid)
      ? input.elevationGrid
      : null;
  const project = createProjectionForBbox(bbox);
  const sf = 1000 / scale;
  const exaggeration = settings.base.elevationExaggeration;
  const sample = (x: number, y: number) => {
    if (!grid) return base;
    const [lng, lat] = project.unproject(x / sf, y / sf);
    return (
      base +
      Math.max(0, sampleElevation(grid, lat, lng) - grid.minElev) *
        sf *
        exaggeration
    );
  };
  if (!grid) {
    const solid = arena.keep(
      arena
        .keep(cad.Manifold.cube([width, depth, base]))
        .translate([-width / 2, -depth / 2, 0]),
    );
    return {
      solid,
      surfaceAt: sample,
      gridVertices: [],
      gridEdges: [],
      maxZ: base,
    };
  }
  const rows = grid.rows,
    cols = grid.cols,
    count = rows * cols;
  const positions = new Float32Array(count * 6);
  const gridVertices: Point2D[] = [];
  let maxZ = base;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const x = -width / 2 + (col / (cols - 1)) * width;
      const y = -depth / 2 + (row / (rows - 1)) * depth;
      const z = sample(x, y);
      positions.set([x, y, z], i * 3);
      positions.set([x, y, 0], (i + count) * 3);
      gridVertices.push([x, y]);
      maxZ = Math.max(maxZ, z);
    }
  const triangles: number[] = [];
  const gridEdges: [Point2D, Point2D][] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const a = row * cols + col;
      if (col + 1 < cols)
        gridEdges.push([gridVertices[a], gridVertices[a + 1]]);
      if (row + 1 < rows)
        gridEdges.push([gridVertices[a], gridVertices[a + cols]]);
      if (row + 1 < rows && col + 1 < cols)
        gridEdges.push([gridVertices[a + 1], gridVertices[a + cols]]);
    }
  for (let row = 0; row < rows - 1; row++)
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col,
        b = a + 1,
        c = a + cols,
        d = c + 1;
      triangles.push(
        a,
        b,
        c,
        b,
        d,
        c,
        a + count,
        c + count,
        b + count,
        b + count,
        c + count,
        d + count,
      );
    }
  const edge: number[] = [];
  for (let col = 0; col < cols; col++) edge.push(col);
  for (let row = 1; row < rows; row++) edge.push(row * cols + cols - 1);
  for (let col = cols - 2; col >= 0; col--) edge.push((rows - 1) * cols + col);
  for (let row = rows - 2; row > 0; row--) edge.push(row * cols);
  for (let j = 0; j < edge.length; j++) {
    const a = edge[j],
      b = edge[(j + 1) % edge.length];
    triangles.push(a, a + count, b, b, a + count, b + count);
  }
  const solid = arena.keep(
    new cad.Manifold(
      new cad.Mesh({
        numProp: 3,
        vertProperties: positions,
        triVerts: new Uint32Array(triangles),
      }),
    ),
  );
  // Use the identical piecewise planar interpolation as the top mesh, rather than
  // bilinear interpolation which would place foundations above/below that mesh.
  const surfaceAt = (x: number, y: number) => {
    const cx = Math.max(
      0,
      Math.min(cols - 1, ((x + width / 2) / width) * (cols - 1)),
    );
    const ry = Math.max(
      0,
      Math.min(rows - 1, ((y + depth / 2) / depth) * (rows - 1)),
    );
    const col = Math.min(cols - 2, Math.floor(cx)),
      row = Math.min(rows - 2, Math.floor(ry));
    const u = cx - col,
      v = ry - row,
      a = row * cols + col;
    const z00 = positions[a * 3 + 2],
      z10 = positions[(a + 1) * 3 + 2];
    const z01 = positions[(a + cols) * 3 + 2],
      z11 = positions[(a + cols + 1) * 3 + 2];
    return u + v <= 1
      ? z00 + u * (z10 - z00) + v * (z01 - z00)
      : z11 + (1 - v) * (z10 - z11) + (1 - u) * (z01 - z11);
  };
  return { solid, surfaceAt, gridVertices, gridEdges, maxZ };
}

/** The maximum of a linear terrain surface lies at an intersection vertex. */
function footprintSurfaceMaximum(
  section: CrossSection,
  terrain: Terrain,
  baseHeight: number,
): number {
  const polygons = section.toPolygons();
  const bounds = section.bounds();
  let maximum = baseHeight;
  const sample = (x: number, y: number) => {
    maximum = Math.max(maximum, terrain.surfaceAt(x, y));
  };
  const contains = (x: number, y: number): boolean =>
    polygons.filter((ring) => pointInPolygon(x, y, ring)).length % 2 === 1;
  for (const ring of polygons) for (const [x, y] of ring) sample(x, y);
  for (const [x, y] of terrain.gridVertices) {
    if (
      x >= bounds.min[0] &&
      x <= bounds.max[0] &&
      y >= bounds.min[1] &&
      y <= bounds.max[1] &&
      contains(x, y)
    )
      sample(x, y);
  }
  for (const [r, s] of terrain.gridEdges) {
    if (
      Math.max(r[0], s[0]) < bounds.min[0] ||
      Math.min(r[0], s[0]) > bounds.max[0] ||
      Math.max(r[1], s[1]) < bounds.min[1] ||
      Math.min(r[1], s[1]) > bounds.max[1]
    )
      continue;
    const dx2 = s[0] - r[0],
      dy2 = s[1] - r[1];
    for (const ring of polygons)
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i],
          q = ring[(i + 1) % ring.length];
        const dx1 = q[0] - p[0],
          dy1 = q[1] - p[1];
        const denominator = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denominator) < 1e-12) continue;
        const rx = r[0] - p[0],
          ry = r[1] - p[1];
        const t = (rx * dy2 - ry * dx2) / denominator;
        const u = (rx * dy1 - ry * dx1) / denominator;
        if (t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8)
          sample(p[0] + t * dx1, p[1] + t * dy1);
      }
  }
  return maximum;
}

function cleanRing(ring: Point2D[]): Point2D[] {
  const result: Point2D[] = [];
  for (const p of ring) {
    if (!p.every(Number.isFinite)) return [];
    const prev = result[result.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 0.00001)
      result.push(p);
  }
  if (
    result.length > 1 &&
    Math.hypot(
      result[0][0] - result.at(-1)![0],
      result[0][1] - result.at(-1)![1],
    ) < 0.00001
  )
    result.pop();
  return result;
}

function roadIncluded(road: RoadData, input: PrintInput): boolean {
  const settings = input.settings.features.roads;
  if (road.isUnderground || settings.roadTypeEnabled[road.roadType] === false)
    return false;
  if (!settings.footpathsEnabled && road.roadClass === "pedestrian")
    return false;
  return (
    settings.filter === "all" ||
    (settings.filter === "minor" && road.roadClass !== "pedestrian") ||
    (settings.filter === "major" &&
      (road.roadClass === "major" || road.roadClass === "railway"))
  );
}

function extractMesh(
  solid: Manifold,
  materialIds: Map<number, PrintLayer>,
): PrintMesh {
  const mesh = solid.getMesh();
  const positions = new Float32Array(
    (mesh.vertProperties.length / mesh.numProp) * 3,
  );
  for (let i = 0; i < positions.length / 3; i++)
    positions.set(
      mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3),
      i * 3,
    );
  const faceLayers = new Uint8Array(mesh.triVerts.length / 3);
  for (let run = 0; run < mesh.runOriginalID.length; run++) {
    const layer = materialIds.get(mesh.runOriginalID[run]) ?? "basePlate";
    faceLayers.fill(
      PRINT_LAYERS.indexOf(layer),
      mesh.runIndex[run] / 3,
      mesh.runIndex[run + 1] / 3,
    );
  }
  // MeshGL can duplicate geometrically identical vertices on original boundaries.
  // Follow its merge vectors so the 3MF indices themselves describe manifold edges.
  const parent = new Uint32Array(positions.length / 3);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  for (let i = 0; i < mesh.mergeFromVert.length; i++)
    parent[mesh.mergeFromVert[i]] = mesh.mergeToVert[i];
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const remap = new Map<number, number>();
  const welded: number[] = [];
  const indices = new Uint32Array(mesh.triVerts.length);
  for (let i = 0; i < indices.length; i++) {
    const key = root(mesh.triVerts[i]);
    let mapped = remap.get(key);
    if (mapped === undefined) {
      mapped = welded.length / 3;
      remap.set(key, mapped);
      welded.push(
        positions[key * 3],
        positions[key * 3 + 1],
        positions[key * 3 + 2],
      );
    }
    indices[i] = mapped;
  }
  return { positions: new Float32Array(welded), indices, faceLayers };
}

function stabilizeSolid(
  cad: ManifoldToplevel,
  arena: Arena,
  solid: Manifold,
): Manifold {
  const mesh = solid.getMesh();
  const count = mesh.vertProperties.length / mesh.numProp;
  const parent = new Uint32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < mesh.mergeFromVert.length; i++)
    parent[root(mesh.mergeFromVert[i])] = root(mesh.mergeToVert[i]);
  let maxCoordinate = 1;
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp)
    for (let j = 0; j < 3; j++)
      maxCoordinate = Math.max(
        maxCoordinate,
        Math.abs(mesh.vertProperties[i + j]),
      );
  const tolerance = Math.max(0.0001, maxCoordinate * 0.0000005);
  // Kernel simplification preserves material boundaries. At an intersection,
  // those boundaries can contain edges smaller than a Float32 ULP. Contract
  // such edges ourselves, then require the repaired topology to pass Manifold.
  for (let i = 0; i < mesh.triVerts.length; i += 3)
    for (let edge = 0; edge < 3; edge++) {
      const a = root(mesh.triVerts[i + edge]),
        b = root(mesh.triVerts[i + ((edge + 1) % 3)]);
      if (a === b) continue;
      const p = mesh.vertProperties,
        ai = a * mesh.numProp,
        bi = b * mesh.numProp;
      if (
        Math.hypot(
          p[ai] - p[bi],
          p[ai + 1] - p[bi + 1],
          p[ai + 2] - p[bi + 2],
        ) < tolerance
      )
        parent[b] = a;
    }
  const remap = new Map<number, number>();
  const positions: number[] = [],
    indices: number[] = [],
    runIndex: number[] = [],
    runOriginalID: number[] = [];
  for (let run = 0; run < mesh.runOriginalID.length; run++) {
    const start = indices.length;
    for (let i = mesh.runIndex[run]; i < mesh.runIndex[run + 1]; i += 3) {
      const roots = [
        root(mesh.triVerts[i]),
        root(mesh.triVerts[i + 1]),
        root(mesh.triVerts[i + 2]),
      ];
      if (new Set(roots).size < 3) continue;
      for (const key of roots) {
        let mapped = remap.get(key);
        if (mapped === undefined) {
          mapped = positions.length / 3;
          remap.set(key, mapped);
          positions.push(
            mesh.vertProperties[key * mesh.numProp],
            mesh.vertProperties[key * mesh.numProp + 1],
            mesh.vertProperties[key * mesh.numProp + 2],
          );
        }
        indices.push(mapped);
      }
    }
    if (indices.length > start) {
      runIndex.push(start);
      runOriginalID.push(mesh.runOriginalID[run]);
    }
  }
  runIndex.push(indices.length);
  const rounded = arena.keep(
    new cad.Manifold(
      new cad.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(positions),
        triVerts: new Uint32Array(indices),
        runIndex: new Uint32Array(runIndex),
        runOriginalID: new Uint32Array(runOriginalID),
        tolerance,
      }),
    ),
  );
  return arena.keep(rounded.simplify(tolerance));
}

/** Check the exported coordinates, since STL consumers weld equal positions. */
export function validatePrintMesh(mesh: PrintMesh): void {
  if (
    !mesh.indices.length ||
    mesh.indices.length % 3 ||
    mesh.positions.length % 3 ||
    mesh.faceLayers.length !== mesh.indices.length / 3
  ) {
    throw new Error("Le maillage exportable est incomplet.");
  }
  const ids = new Map<string, number>();
  const vertices = new Uint32Array(mesh.positions.length / 3);
  for (let i = 0; i < vertices.length; i++) {
    const x = mesh.positions[i * 3],
      y = mesh.positions[i * 3 + 1],
      z = mesh.positions[i * 3 + 2];
    if (![x, y, z].every(Number.isFinite))
      throw new Error("Le maillage contient des coordonnées invalides.");
    const key = `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    vertices[i] = id;
  }
  const edges = new Map<string, { count: number; direction: number }>();
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i],
      b = mesh.indices[i + 1],
      c = mesh.indices[i + 2];
    if (a >= vertices.length || b >= vertices.length || c >= vertices.length)
      throw new Error("Le maillage contient une face invalide.");
    const va = vertices[a],
      vb = vertices[b],
      vc = vertices[c];
    if (va === vb || vb === vc || vc === va)
      throw new Error(
        "Une face trop petite ne peut pas être exportée avec précision. Choisissez un profil plus épuré.",
      );
    for (const [x, y] of [
      [va, vb],
      [vb, vc],
      [vc, va],
    ]) {
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      const edge = edges.get(key) ?? { count: 0, direction: 0 };
      edge.count++;
      edge.direction += x < y ? 1 : -1;
      edges.set(key, edge);
    }
    const p = mesh.positions;
    const ux = p[b * 3] - p[a * 3],
      uy = p[b * 3 + 1] - p[a * 3 + 1],
      uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3],
      vy = p[c * 3 + 1] - p[a * 3 + 1],
      vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz <= 1e-20)
      throw new Error(
        "Le maillage contient une face collinéaire sans surface imprimable.",
      );
    volume +=
      (p[a * 3] * (p[b * 3 + 1] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3 + 1]) -
        p[a * 3 + 1] * (p[b * 3] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3]) +
        p[a * 3 + 2] * (p[b * 3] * p[c * 3 + 1] - p[b * 3 + 1] * p[c * 3])) /
      6;
  }
  for (const edge of edges.values())
    if (edge.count !== 2 || edge.direction !== 0) {
      throw new Error(
        "Le modèle contient une jonction qui ne peut pas être imprimée correctement. Choisissez un profil plus épuré ou une zone plus petite.",
      );
    }
  if (!(volume > 0))
    throw new Error("Le maillage ne contient pas de volume imprimable.");
}

/** Build the actual printable solid, shared by preview, STL and 3MF. */
export async function buildPrintModel(
  input: PrintInput,
  onProgress: PrintProgress = () => {},
): Promise<PrintModel> {
  validateInput(input);
  onProgress(3, "Initialisation du moteur de solides");
  const cad = await getRuntime();
  const arena = new Arena();
  try {
    const { bbox, scale, settings } = input;
    const sf = 1000 / scale;
    const projection = createProjectionForBbox(bbox);
    const [west, south] = projection.project(bbox[1], bbox[0]);
    const [east, north] = projection.project(bbox[3], bbox[2]);
    const width = (east - west) * sf,
      depth = (north - south) * sf;
    if (width < 1 || depth < 1 || width > 5000 || depth > 5000)
      throw new Error("La maquette doit mesurer entre 1 et 5 000 mm par côté.");
    const clip = arena.keep(cad.CrossSection.square([width, depth], true));
    const terrain = makeTerrain(cad, arena, input, width, depth);
    const materialIds = new Map<number, PrintLayer>();
    const tag = (solid: Manifold, layer: PrintLayer): Manifold => {
      const original = arena.keep(solid.asOriginal());
      materialIds.set(original.originalID(), layer);
      return original;
    };
    const stats: PrintModel["stats"] = {
      buildingCount: 0,
      roadCount: 0,
      waterCount: 0,
      parkCount: 0,
      sandCount: 0,
      pierCount: 0,
      discardedFeatures: 0,
      triangleCount: 0,
      components: 0,
      volumeMm3: 0,
      estimatedHeights: 0,
    };
    const warnings: string[] = [];
    if (settings.base.topographyEnabled && !validElevation(input.elevationGrid))
      warnings.push("Relief indisponible : la maquette utilise un socle plat.");
    const solids: Manifold[] = [];
    let base = tag(terrain.solid, "basePlate");
    const {
      minFeatureMm,
      minBuildingAreaMm2,
      minBuildingHeightMm,
      simplifyMm,
    } = settings.print;
    const footprint = (
      polygon: Polygon2D,
      minArea = minFeatureMm * minFeatureMm,
    ): CrossSection | null => {
      const outer = cleanRing(polygon.outer);
      if (outer.length < 3) return null;
      const holes = polygon.holes
        .map(cleanRing)
        .filter((ring) => ring.length >= 3);
      const section = arena.keep(
        new cad.CrossSection([outer, ...holes], "EvenOdd"),
      );
      const clipped = arena.keep(section.intersect(clip));
      const simplified = arena.keep(clipped.simplify(simplifyMm));
      if (simplified.isEmpty() || simplified.area() < minArea) return null;
      return simplified;
    };
    const corridor = (
      line: Point2D[],
      halfWidth: number,
    ): CrossSection | null => {
      // Closed routes (roundabouts) keep their closing segment.
      const clean = cleanRing(line);
      if (
        line.length > 2 &&
        clean.length > 2 &&
        Math.hypot(line[0][0] - line.at(-1)![0], line[0][1] - line.at(-1)![1]) <
          0.00001
      )
        clean.push(clean[0]);
      const points = simplifyPolyline(clean, simplifyMm);
      if (points.length < 2 || !Number.isFinite(halfWidth) || halfWidth <= 0)
        return null;
      const radius = Math.max(halfWidth, minFeatureMm / 2);
      const parts: CrossSection[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = points[i],
          [x1, y1] = points[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.001) continue;
        const nx = ((y1 - y0) / len) * radius,
          ny = ((x1 - x0) / len) * radius;
        parts.push(
          arena.keep(
            new cad.CrossSection([
              [
                [x0 + nx, y0 - ny],
                [x1 + nx, y1 - ny],
                [x1 - nx, y1 + ny],
                [x0 - nx, y0 + ny],
              ],
            ]),
          ),
        );
      }
      for (const point of points)
        parts.push(
          arena.keep(
            arena.keep(cad.CrossSection.circle(radius, 12)).translate(point),
          ),
        );
      if (!parts.length) return null;
      const union = arena.keep(cad.CrossSection.union(parts));
      const clipped = arena.keep(union.intersect(clip));
      return clipped.isEmpty() ||
        clipped.area() < (minFeatureMm * minFeatureMm) / 2
        ? null
        : clipped;
    };
    const combine = (sections: CrossSection[]): CrossSection | null =>
      sections.length ? arena.keep(cad.CrossSection.union(sections)) : null;
    // Intersect an extruded footprint with the raised terrain. This exactly
    // follows terrain triangles, and overlaps the socle instead of floating.
    const emboss = (
      section: CrossSection,
      height: number,
      layer: PrintLayer,
    ): void => {
      if (!Number.isFinite(height) || height <= 0) return;
      const prism = arena.keep(section.extrude(terrain.maxZ + height + 1));
      // Keep the bottom at Z=0 while lifting the top, so even tall features
      // remain supported and retain their requested height exactly.
      const raisedTerrain = arena.keep(
        terrain.solid.warp((vertex) => {
          if (vertex[2] > 0) vertex[2] += height;
        }),
      );
      solids.push(tag(arena.keep(prism.intersect(raisedTerrain)), layer));
    };
    const parsed = parseElements(input.osmData.elements, bbox, scale);
    onProgress(12, "Préparation des empreintes et du relief");
    const sharedVertices = new Map<string, Set<number>>();
    for (let i = 0; i < parsed.buildings.length; i++)
      for (const point of parsed.buildings[i].polygon.outer) {
        const key = point.map((value) => Math.round(value * 10000)).join(",");
        const owners = sharedVertices.get(key) ?? new Set<number>();
        owners.add(i);
        sharedVertices.set(key, owners);
      }
    const touchingBuildings = new Set<number>();
    for (const owners of sharedVertices.values())
      if (owners.size > 1)
        for (const owner of owners) touchingBuildings.add(owner);
    const preparedBuildings: {
      building: BuildingData;
      section: CrossSection;
      height: number;
    }[] = [];
    if (settings.features.buildings.enabled)
      for (let i = 0; i < parsed.buildings.length; i++) {
        const building = parsed.buildings[i];
        let section = footprint(
          building.polygon,
          Math.max(
            minBuildingAreaMm2,
            settings.features.buildings.minAreaM2 * sf * sf,
          ),
        );
        const totalHeight =
          (building.wallHeight + building.roofHeight) *
          settings.features.buildings.buildingScale;
        if (
          !section ||
          !Number.isFinite(totalHeight) ||
          totalHeight / sf < settings.features.buildings.minHeightM
        ) {
          stats.discardedFeatures++;
          continue;
        }
        const inset = arena.keep(section.offset(-minFeatureMm / 2, "Miter"));
        if (inset.isEmpty()) {
          stats.discardedFeatures++;
          continue;
        }
        // Exact corner contacts would give the STL four faces along one edge.
        // Only retained buildings sharing source vertices receive a tiny overlap.
        if (touchingBuildings.has(i))
          section = arena.keep(
            arena.keep(section.offset(0.005, "Miter")).intersect(clip),
          );
        preparedBuildings.push({
          building,
          section,
          height: Math.max(totalHeight, minBuildingHeightMm),
        });
      }
    // Area boundaries from OSM often touch building corners exactly. A tiny
    // clearance prevents four exterior faces from meeting on the same edge.
    const buildingMasks = preparedBuildings.map(({ section }) => section);
    const buildingUnion = combine(buildingMasks);
    const buildingClearance = buildingUnion
      ? arena.keep(buildingUnion.offset(0.015, "Miter"))
      : null;
    const regularizeArea = (section: CrossSection): CrossSection => {
      const expanded = arena.keep(section.offset(0.005, "Miter"));
      const closed = arena.keep(expanded.offset(-0.005, "Miter"));
      const bounded = arena.keep(closed.intersect(clip));
      return buildingClearance
        ? arena.keep(bounded.subtract(buildingClearance))
        : bounded;
    };

    const waters: CrossSection[] = [];
    if (settings.features.water.enabled) {
      for (const water of parsed.waterAreas) {
        if (water.isOcean && !settings.features.water.oceanEnabled) continue;
        const section = footprint(
          water.polygon,
          Math.max(
            minFeatureMm * minFeatureMm,
            settings.features.water.minAreaM2 * sf * sf,
          ),
        );
        if (section) {
          waters.push(section);
          stats.waterCount++;
        } else stats.discardedFeatures++;
      }
      for (const water of parsed.waterways) {
        const section = corridor(water.polyline, water.halfWidth);
        if (section) {
          waters.push(section);
          stats.waterCount++;
        } else stats.discardedFeatures++;
      }
    }
    const rawWaterSection = combine(waters);
    const waterSection = rawWaterSection
      ? regularizeArea(rawWaterSection)
      : null;
    const waterClearance = waterSection
      ? arena.keep(waterSection.offset(0.015, "Miter"))
      : null;
    if (waterSection) {
      const requestedDepth = settings.features.water.waterDepthMm;
      if (requestedDepth > 0 || settings.features.water.waterCutout) {
        const cutDepth = Math.min(
          Math.max(requestedDepth, 0.2),
          settings.base.basePlateThicknessMm - 1,
        );
        if (cutDepth > 0) {
          const prism = arena.keep(waterSection.extrude(terrain.maxZ + 1));
          const lowered = arena.keep(
            terrain.solid.translate([0, 0, -cutDepth]),
          );
          const cutter = tag(arena.keep(prism.subtract(lowered)), "water");
          base = arena.keep(base.subtract(cutter));
        }
      } else emboss(waterSection, settings.features.water.heightMm, "water");
    }
    for (const layer of ["sand", "parks", "piers"] as const) {
      if (!settings.features[layer].enabled) continue;
      const areas =
        layer === "sand"
          ? parsed.sandAreas
          : layer === "parks"
            ? parsed.parks
            : parsed.piers;
      const sections: CrossSection[] = [];
      for (const polygon of areas) {
        let section = footprint(polygon);
        if (section && waterClearance && layer !== "piers")
          section = arena.keep(section.subtract(waterClearance));
        if (section && !section.isEmpty()) {
          sections.push(section);
          stats[
            layer === "sand"
              ? "sandCount"
              : layer === "parks"
                ? "parkCount"
                : "pierCount"
          ]++;
        } else stats.discardedFeatures++;
      }
      if (layer === "piers")
        for (const pier of parsed.pierLines) {
          const section = corridor(pier.polyline, pier.halfWidth);
          if (section) {
            sections.push(section);
            stats.pierCount++;
          } else stats.discardedFeatures++;
        }
      const raw = combine(sections);
      const section = raw ? regularizeArea(raw) : null;
      if (section) emboss(section, settings.features[layer].heightMm, layer);
    }
    onProgress(28, "Construction des routes et des espaces naturels");
    let supportedStructures = 0;
    if (settings.features.roads.enabled) {
      const roads: CrossSection[] = [];
      for (const road of parsed.roads) {
        if (!roadIncluded(road, input)) {
          stats.discardedFeatures++;
          continue;
        }
        const section = corridor(
          road.polyline,
          road.halfWidth * settings.features.roads.widthMultiplier,
        );
        if (section) {
          roads.push(section);
          stats.roadCount++;
          if (road.isBridge) supportedStructures++;
        } else stats.discardedFeatures++;
      }
      const roadSection = combine(roads);
      if (roadSection)
        emboss(roadSection, settings.features.roads.heightMm, "roads");
    }
    if (settings.features.buildings.enabled) {
      let flattenedRoofs = 0;
      for (let i = 0; i < preparedBuildings.length; i++) {
        const { building, section, height } = preparedBuildings[i];
        const polygons = section.toPolygons();
        const surfaceZ = footprintSurfaceMaximum(
          section,
          terrain,
          settings.base.basePlateThicknessMm,
        );
        const explicitRoof = settings.features.buildings.roofs
          ? building.tags["roof:shape"]
          : undefined;
        const canRoof =
          !building.polygon.holes.length &&
          building.classification.footprintClass !== "complex" &&
          (explicitRoof === "gabled" ||
            explicitRoof === "hipped" ||
            explicitRoof === "pyramidal");
        const roofHeight = canRoof
          ? Math.min(
              height * 0.6,
              building.roofHeight > 0
                ? building.roofHeight *
                    settings.features.buildings.buildingScale
                : height * 0.25,
            )
          : 0;
        const wallTop = surfaceZ + height - roofHeight;
        // Full foundation through the underlying terrain supports every building.
        const startZ = Math.max(0.2, settings.base.basePlateThicknessMm - 0.3);
        let solid = arena.keep(
          arena
            .keep(section.extrude(wallTop - startZ))
            .translate([0, 0, startZ]),
        );
        if (canRoof && roofHeight > 0.02) {
          const roof = makeRoof(
            cad,
            arena,
            building,
            polygons,
            wallTop,
            roofHeight,
            explicitRoof!,
          );
          const prism = arena.keep(
            arena
              .keep(section.extrude(roofHeight + 0.1))
              .translate([0, 0, wallTop - 0.03]),
          );
          solid = arena.keep(solid.add(arena.keep(roof.intersect(prism))));
        } else if (explicitRoof && explicitRoof !== "flat") flattenedRoofs++;
        solids.push(tag(solid, "buildings"));
        stats.buildingCount++;
        if (
          building.heightSource === "Estimation" ||
          building.heightSource?.includes("étages") ||
          (!building.heightSource &&
            !building.tags.height &&
            !building.tags["building:height"])
        )
          stats.estimatedHeights++;
        if ((building.minHeight ?? 0) > 0) supportedStructures++;
        if (i % 100 === 0)
          onProgress(
            32 + Math.round((i / Math.max(1, preparedBuildings.length)) * 35),
            "Construction des bâtiments et des cours",
          );
      }
      if (flattenedRoofs)
        warnings.push(
          `${flattenedRoofs} toiture(s) complexe(s) représentée(s) à plat pour conserver un solide fiable.`,
        );
    }
    if (settings.base.frame.enabled) {
      const thickness = Math.min(
        settings.base.frame.thicknessMm,
        width / 4,
        depth / 4,
      );
      const radius = Math.min(thickness * 2, width / 4, depth / 4);
      // Keep the requested print dimensions: the border occupies the inside of
      // the selected rectangle, including when its corners are rounded.
      const square = settings.base.frame.rounded
        ? arena.keep(
            cad.CrossSection.square(
              [width - radius * 2, depth - radius * 2],
              true,
            ),
          )
        : clip;
      const outer = settings.base.frame.rounded
        ? arena.keep(square.offset(radius, "Round", 2, 24))
        : clip;
      const inner = arena.keep(
        outer.offset(
          -thickness,
          settings.base.frame.rounded ? "Round" : "Miter",
          2,
          24,
        ),
      );
      const ring = arena.keep(outer.subtract(inner));
      emboss(ring, settings.base.frame.heightMm, "frame");
    }
    onProgress(72, "Fusion du socle et des détails en un seul solide");
    const union = arena.keep(cad.Manifold.union([base, ...solids]));
    // The renderer/STL stores Float32 coordinates. Remove intersections smaller
    // than a micron before conversion so they cannot collapse into zero-area faces.
    const merged = stabilizeSolid(cad, arena, union);
    if (merged.status() !== "NoError" || merged.isEmpty())
      throw new Error(
        "Le moteur n’a pas pu produire un solide fermé. Réduisez la zone ou choisissez un profil plus épuré.",
      );
    const components = merged.decompose();
    for (const component of components) arena.keep(component);
    // Coplanar boolean intersections can leave topological zero-volume shells.
    // They carry no printable material and must not become detached mesh faces.
    const printable = components.filter(
      (component) => component.volume() > 0.000001,
    );
    stats.components = printable.length;
    if (printable.length !== 1)
      throw new Error(
        "Le modèle contient des détails détachés du socle. Réduisez la zone ou désactivez les détails concernés.",
      );
    const result = printable[0];
    stats.volumeMm3 = result.volume();
    const bounds = result.boundingBox();
    const mesh = extractMesh(result, materialIds);
    validatePrintMesh(mesh);
    stats.triangleCount = mesh.indices.length / 3;
    const tiles: PrintTile[] = [];
    const { cols, rows } = settings.base.grid;
    const widthMm = bounds.max[0] - bounds.min[0],
      depthMm = bounds.max[1] - bounds.min[1];
    if (cols * rows > 1) {
      onProgress(88, "Découpe et fermeture des tuiles");
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          const minX = bounds.min[0] + (col / cols) * widthMm;
          const minY = bounds.min[1] + (row / rows) * depthMm;
          const tileWidth = widthMm / cols,
            tileDepth = depthMm / rows;
          const cube = arena.keep(
            arena
              .keep(
                cad.Manifold.cube([tileWidth, tileDepth, bounds.max[2] + 1]),
              )
              .translate([minX, minY, 0]),
          );
          const cut = arena.keep(result.intersect(cube));
          const cleaned = stabilizeSolid(cad, arena, cut);
          const tile = arena.keep(
            cleaned.translate([
              -minX - tileWidth / 2,
              -minY - tileDepth / 2,
              0,
            ]),
          );
          if (tile.status() !== "NoError" || tile.isEmpty())
            throw new Error("Échec de la fermeture d’une tuile.");
          const tileMesh = extractMesh(tile, materialIds);
          validatePrintMesh(tileMesh);
          tiles.push({
            ...tileMesh,
            col,
            row,
            widthMm: tileWidth,
            depthMm: tileDepth,
          });
        }
    }
    if (stats.estimatedHeights)
      warnings.push(
        `${stats.estimatedHeights} bâtiment(s) utilisent une hauteur estimée faute de mesure disponible.`,
      );
    if (supportedStructures)
      warnings.push(
        `${supportedStructures} pont(s) ou volume(s) surélevé(s) sont rattachés au socle pour éviter les pièces flottantes.`,
      );
    if (stats.discardedFeatures)
      warnings.push(
        `${stats.discardedFeatures} élément(s) trop petits, hors zone ou exclus par le profil ont été écartés.`,
      );
    onProgress(100, "Maquette prête à imprimer");
    return {
      ...mesh,
      tiles,
      dimensions: { widthMm, depthMm, heightMm: bounds.max[2] },
      stats,
      warnings,
      sources: buildSources(input),
      fetchedAt: input.report?.fetchedAt ?? new Date().toISOString(),
      osmTimestamp:
        input.report?.osmTimestamp ?? input.osmData.osm3s?.timestamp_osm_base,
      colors: {
        basePlate: settings.base.baseColor,
        buildings: settings.features.buildings.color,
        roads: settings.features.roads.color,
        water: settings.features.water.color,
        parks: settings.features.parks.color,
        sand: settings.features.sand.color,
        piers: settings.features.piers.color,
        frame: settings.base.frame.color,
      },
    };
  } finally {
    arena.dispose();
  }
}

function buildSources(input: PrintInput): string[] {
  const sources = [...(input.report?.sources ?? ["OpenStreetMap · Overpass"])];
  if (sources.some((source) => /OpenStreetMap|OpenMapTiles/.test(source)))
    sources.push(
      "© OpenStreetMap contributors — ODbL · https://www.openstreetmap.org/copyright",
    );
  if (sources.some((source) => /OpenFreeMap/.test(source)))
    sources.push(
      "OpenFreeMap © OpenMapTiles Data from OpenStreetMap · https://openfreemap.org/",
    );
  if (sources.some((source) => /IGN/.test(source)))
    sources.push(
      "IGN — Licence Ouverte Etalab 2.0 · https://geoservices.ign.fr/conditions-utilisation",
    );
  if (sources.some((source) => /Open-Meteo|Copernicus/.test(source)))
    sources.push(
      "Copernicus DEM GLO-90 via Open-Meteo · https://open-meteo.com/en/docs/elevation-api · https://doi.org/10.5270/ESA-c5d3d65",
    );
  return [...new Set(sources)];
}

function makeRoof(
  cad: ManifoldToplevel,
  arena: Arena,
  building: BuildingData,
  polygons: Point2D[][],
  baseZ: number,
  height: number,
  shape: string,
): Manifold {
  const axis = building.classification.dominantAxis;
  const perp: Point2D = [-axis[1], axis[0]];
  let minA = Infinity,
    maxA = -Infinity,
    minB = Infinity,
    maxB = -Infinity;
  const points: Vec3[] = [];
  for (const ring of polygons)
    for (const [x, y] of ring) {
      // The lower ring overlaps the walls, while the upper eaves retain their
      // actual height; the roof slope is not altered by the welding overlap.
      points.push([x, y, baseZ], [x, y, baseZ - 0.02]);
      const a = x * axis[0] + y * axis[1],
        b = x * perp[0] + y * perp[1];
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
    }
  const centerA = (minA + maxA) / 2,
    centerB = (minB + maxB) / 2;
  const halfLong = (maxA - minA) / 2,
    halfShort = (maxB - minB) / 2;
  const ridge =
    shape === "pyramidal"
      ? 0
      : shape === "hipped"
        ? Math.max(0, halfLong - halfShort)
        : halfLong;
  for (const a of ridge ? [centerA - ridge, centerA + ridge] : [centerA])
    points.push([
      a * axis[0] + centerB * perp[0],
      a * axis[1] + centerB * perp[1],
      baseZ + height,
    ]);
  return arena.keep(cad.Manifold.hull(points));
}
