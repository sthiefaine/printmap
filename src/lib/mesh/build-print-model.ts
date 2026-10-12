import Module, {
  type CrossSection,
  type Manifold,
  type ManifoldToplevel,
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
import { makeStairFlight, type StairFlight } from "./stair-solid";
import {
  makeMeasuredSolid,
  makeMeasuredRoofFallbackFootprint,
} from "./measured-solid";
import { makeSurveyedArch } from "./bridge-solid";
import { makeMeasuredBridgeApproach } from "./measured-bridge-approach";
import { removeNumericalShells } from "./retain-shells";
import { openEdgeContacts } from "./open-edge-contacts";
import { makeBasinRim } from "./basin-rim";
import { buildMeasuredStairReference } from "./measured-stair-reference";
import { makeAqueduct } from "./aqueduct-solid";
import { buildMeasuredTerraces } from "./measured-terraces";
import { makeMappedRetainingWall } from "./mapped-retaining-wall";
import { repairNumericalTriangles } from "./repair-numerical-triangles";
import { contractShortEdges } from "./contract-short-edges";
import { parseLengthMeters } from "../osm/building-height";
import {
  parseElements,
  type BuildingData,
  type RoadData,
} from "../osm/parse-elements";
import { simplifyPolyline } from "../polygon/simplify";
import { pointInPolygon } from "../polygon/point-in-polygon";
import { makeRoof, makeMeasuredRoof } from "./roof-solid";
import { makeLidarRoof } from "./lidar-roof";
import { repairCoincident, removeCoincidentSheets } from "./repair-coincident";
import { repairCollinear } from "./repair-collinear";
import { preparePrintLayers } from "./fuse-print-layers";

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
  terraceCount?: number;
  terraceWarnings?: string[];
  terraceSources?: string[];
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
  let solid = arena.keep(
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
  const originalSurfaceAt = (x: number, y: number) => {
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
  const terraces = buildMeasuredTerraces(
    input.osmData.elements,
    grid,
    (lon, lat) =>
      project.project(lon, lat).map((value) => value * sf) as Point2D,
    sf,
  );
  const terraceWarnings: string[] = [];
  const terraceSources: string[] = [];
  const selection = arena.keep(cad.CrossSection.square([width, depth], true));
  const elevationZ = (elevation: number) =>
    base + Math.max(0, elevation - grid.minElev) * sf * exaggeration;
  for (const terrace of terraces) {
    const toSection = (polygon: Polygon2D) =>
      arena.keep(
        new cad.CrossSection([polygon.outer, ...polygon.holes], "EvenOdd"),
      );
    let section = arena.keep(
      cad.CrossSection.union(terrace.polygons.map(toSection)),
    );
    const exclusions = terrace.exclusions.length
      ? arena.keep(cad.CrossSection.union(terrace.exclusions.map(toSection)))
      : null;
    if (exclusions) section = arena.keep(section.subtract(exclusions));
    section = arena.keep(section.intersect(selection));
    if (section.isEmpty()) continue;
    const rings = section.toPolygons();
    let patchMax = base;
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const point = ring[i];
        patchMax = Math.max(
          patchMax,
          elevationZ(terrace.elevationAt(...point)),
        );
        gridVertices.push(point);
        gridEdges.push([point, ring[(i + 1) % ring.length]]);
      }
    maxZ = Math.max(maxZ, patchMax);
    const cutter = arena.keep(section.extrude(maxZ + 1));
    let insertSection = arena.keep(
      arena.keep(section.offset(0.001, "Miter")).intersect(selection),
    );
    // Numerical overlap belongs outside the patch, never inside a measured
    // building exclusion where it could create a film on a vertical facade.
    if (exclusions)
      insertSection = arena.keep(insertSection.subtract(exclusions));
    const platform = arena.keep(
      arena.keep(insertSection.extrude(1)).warp((vertex) => {
        vertex[2] =
          vertex[2] > 0.5
            ? elevationZ(terrace.elevationAt(vertex[0], vertex[1]))
            : 0;
      }),
    );
    solid = arena.keep(arena.keep(solid.subtract(cutter)).add(platform));
    terraceWarnings.push(
      `${terrace.name} : terrasse reconstituée dans ses limites cartographiées, pente ${terrace.slopePercent.toFixed(2)} %, niveau estimé par ${terrace.sampleCount} points du terrain (écart aux points du terrain ${terrace.fitRmsM.toFixed(2)} m). Le relevé raster lissé aux murs de soutènement est remplacé localement ; les jardins inférieurs gardent leur relief.`,
    );
    terraceSources.push(`${terrace.source} · ${terrace.sourceUrl}`);
  }
  let surfaceAt = (x: number, y: number) => {
    const terrace = terraces.find((item) => item.contains(x, y));
    return terrace
      ? elevationZ(terrace.elevationAt(x, y))
      : originalSurfaceAt(x, y);
  };
  if (
    grid.source?.includes("IGN") &&
    grid.resolutionM &&
    grid.resolutionM <= 15
  ) {
    for (const id of [1305300161, 1305300162]) {
      const element = input.osmData.elements.find(
        (item) =>
          item.type === "way" &&
          item.id === id &&
          item.tags?.barrier === "retaining_wall",
      );
      if (!element?.geometry?.length) continue;
      const maximum = parseLengthMeters(
        element.tags?.["printmap:structure_max_height"],
      );
      const wall = makeMappedRetainingWall(cad, arena, {
        polylineMm: element.geometry.map(
          (point) =>
            project
              .project(point.lon, point.lat)
              .map((value) => value * sf) as Point2D,
        ),
        clip: selection,
        resolutionMm: grid.resolutionM * sf,
        surfaceAt,
        terrainMaxZ: maxZ,
        foundationZ: Math.max(0.2, base - 0.3),
        sourceMaxHeightMm: maximum == null ? undefined : maximum * sf,
        sourceVerticalUncertaintyMm: 1.5 * sf,
      });
      if (!wall) continue;
      solid = arena.keep(
        arena.keep(solid.subtract(wall.cutter)).add(wall.solid),
      );
      surfaceAt = wall.surfaceAt;
      gridVertices.push(...wall.topVertices);
      gridEdges.push(...wall.topEdges);
      maxZ = Math.max(maxZ, wall.maxZ);
      terraceWarnings.push(
        `Mur de soutènement way/${id} : rupture reconstituée sur le tracé OSM, dans une bande de ${(wall.widthMm / sf).toFixed(1)} m. Niveaux variables estimés depuis ${wall.sampleCount} points du terrain hors zone lissée ; hauteur ${(wall.minimumHeightMm / sf).toFixed(2)}–${(wall.maximumHeightMm / sf).toFixed(2)} m. ${maximum == null ? "Maximum non renseigné." : `Maximum d’inventaire ${maximum} m utilisé pour le contrôle de cohérence, avec marge de 1,5 m, et non comme hauteur uniforme.`}`,
      );
      terraceSources.push(
        "© OpenStreetMap contributors · murs cartographiés · ODbL · https://www.openstreetmap.org/copyright",
        "Montpellier Méditerranée Métropole · ouvrages d’art · ODbL · https://data.montpellier3m.fr/dataset/ouvrages-dart-de-montpellier-mediterranee-metropole",
      );
    }
  }
  return {
    solid,
    surfaceAt,
    gridVertices,
    gridEdges,
    maxZ,
    terraceCount: terraces.length,
    terraceWarnings,
    terraceSources,
  };
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

function roadIncluded(
  road: Pick<RoadData, "isUnderground" | "roadType" | "roadClass"> & {
    tags?: Record<string, string>;
  },
  input: PrintInput,
): boolean {
  const settings = input.settings.features.roads;
  if (road.isUnderground || settings.roadTypeEnabled[road.roadType] === false)
    return false;
  if (road.roadType === "steps") {
    const indoor = road.tags?.indoor?.trim().toLowerCase();
    const location = road.tags?.location?.trim().toLowerCase();
    // An indoor escalator does not replace the outside terrain. Its full-height
    // ramp cutter would otherwise remove surveyed roofs above the mapped route.
    if (indoor === "yes" || indoor === "steps" || location === "indoor")
      return false;
    return settings.filter !== "major";
  }
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
  minimumTolerance = 0.001,
  preserveNativeTolerance = false,
): Manifold {
  const mesh = solid.getMesh();
  let maxCoordinate = 1;
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp)
    for (let j = 0; j < 3; j++)
      maxCoordinate = Math.max(
        maxCoordinate,
        Math.abs(mesh.vertProperties[i + j]),
      );
  const tolerance = Math.max(minimumTolerance, maxCoordinate * 0.0000005);
  // A short edge alone does not authorise changing a surface's topology.
  // Contract only native edges with a valid link and unchanged neighbouring
  // winding, while retaining separate shells and export contact clearances.
  const rounded = arena.keep(
    new cad.Manifold(
      contractShortEdges(cad, mesh, tolerance, preserveNativeTolerance),
    ),
  );
  // The explicit contractions already use the requested bound. Increasing the
  // kernel's own tolerance again can retriangulate a surveyed horizontal roof
  // through a much lower wall vertex, as on the Polygone's stepped roof.
  const simplified = arena.keep(
    rounded.simplify(
      preserveNativeTolerance ? Math.min(tolerance, mesh.tolerance) : tolerance,
    ),
  );
  return arena.keep(
    new cad.Manifold(
      repairNumericalTriangles(
        cad,
        repairCollinear(cad, repairCoincident(cad, simplified.getMesh())),
      ),
    ),
  );
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
    if (nx * nx + ny * ny + nz * nz <= 1e-20) {
      throw new Error(
        "Le maillage contient une face collinéaire sans surface imprimable.",
      );
    }
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
      realRoofCount: 0,
      lidarRoofCount: 0,
      taggedRoofCount: 0,
      staircaseCount: 0,
      measuredStructureCount: 0,
      reconstructedBridgeCount: 0,
      basinRimCount: 0,
      reconstructedAqueductCount: 0,
      aqueductArchCount: 0,
    };
    const warnings: string[] = [...(terrain.terraceWarnings ?? [])];
    const derivedSources: string[] = [...(terrain.terraceSources ?? [])];
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
      preserveMeasuredContour = false,
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
      // Simplification can fill surveyed indentations and make complete roofs
      // appear to miss their footprint. Measured surfaces retain the exact clip.
      const prepared = preserveMeasuredContour
        ? clipped
        : arena.keep(clipped.simplify(simplifyMm));
      if (prepared.isEmpty() || prepared.area() < minArea) return null;
      return prepared;
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
    // Replace the terrain inside the footprint, rather than stacking a slab on it.
    // At zero offset the geometry stays exactly at the DEM surface, while the
    // face provenance retains the colour of roads, gardens and water in 3MF.
    // Later surfaces replace earlier ones, so a road through a park stays road.
    const laySurface = (
      section: CrossSection,
      requestedOffset: number,
      layer: PrintLayer,
    ): void => {
      if (!Number.isFinite(requestedOffset)) return;
      const offset = Math.max(
        requestedOffset,
        1 - settings.base.basePlateThicknessMm,
      );
      if (offset !== requestedOffset)
        warnings.push(
          "La gravure a été limitée pour conserver au moins 1 mm de socle.",
        );
      if (offset <= 0 && terrain.terraceCount) {
        if (offset < 0) {
          const loweredTerrain = arena.keep(
            terrain.solid.warp((vertex) => {
              if (vertex[2] > 0) vertex[2] += offset;
            }),
          );
          // Engrave twenty microns inside the footprint: crossing the exact edge
          // of a vertical terrace can leave a coincident sheet after export.
          // Subtraction from the current base preserves every existing cavity.
          const engravingSection = arena.keep(
            arena
              .keep(section.offset(-0.02, "Miter"))
              .intersect(arena.keep(clip.offset(-0.002, "Miter"))),
          );
          if (engravingSection.isEmpty()) return;
          const engravingPrism = arena.keep(
            engravingSection.extrude(terrain.maxZ + 1),
          );
          const engravingCutter = arena.keep(
            engravingPrism.subtract(loweredTerrain),
          );
          base = arena.keep(base.subtract(engravingCutter));
        }
        // Keep the colour partition five microns inside the mapped boundary
        // after its overlap. A terrace can have a vertical break on that exact
        // boundary; cutting through it would recreate a coplanar contact film.
        // The palette boundary remains outside the engraved step, so their
        // edges cannot create coincident films while the ground is recoloured.
        const bounded = arena.keep(
          arena.keep(section.offset(-0.01, "Miter")).intersect(clip),
        );
        if (bounded.isEmpty()) return;
        const prism = arena.keep(bounded.extrude(terrain.maxZ + 1));
        const [inside, outside] = base.split(prism);
        arena.keep(inside);
        arena.keep(outside);
        // Partition the current ground itself, including terrace corrections
        // and cavities. Reusing a separate DEM skin can create coincident films
        // along vertical walls. A five-micron overlap keeps the same volume and
        // elevation while making the colour boundary robust to Float32 export.
        const overlappingSection = arena.keep(
          arena.keep(bounded.offset(0.005, "Miter")).intersect(clip),
        );
        const overlappingPrism = arena.keep(
          overlappingSection.extrude(terrain.maxZ + 1),
        );
        const overlappingInside = arena.keep(base.intersect(overlappingPrism));
        base = arena.keep(outside.add(tag(overlappingInside, layer)));
        return;
      }
      const shiftedTerrain = (shift: number) =>
        arena.keep(
          terrain.solid.warp((vertex) => {
            if (vertex[2] > 0) vertex[2] += shift;
          }),
        );
      const top = shiftedTerrain(offset);
      const underneath = shiftedTerrain(Math.min(offset, 0) - 0.3);
      // Leave a two-micron rim at the clipped outer wall. That wall is already
      // closed by the terrain; replacing it coplanarly can create duplicate
      // boundary sheets after Float32 rounding at grid/selection intersections.
      const insetClip = arena.keep(clip.offset(-0.002, "Miter"));
      const bounded = arena.keep(section.intersect(insetClip));
      if (bounded.isEmpty()) return;
      const prism = arena.keep(
        bounded.extrude(terrain.maxZ + Math.max(0, offset) + 1),
      );
      // A micron of horizontal overlap avoids duplicate vertical walls where
      // independently clipped DEM triangles round to different Float32 planes.
      // The top remains at the exact terrain height; no vertical embossing.
      const insertSection = arena.keep(
        arena
          .keep(bounded.offset(0.001, "Miter"))
          .intersect(arena.keep(clip.offset(-0.001, "Miter"))),
      );
      const insertPrism = arena.keep(
        insertSection.extrude(terrain.maxZ + Math.max(0, offset) + 1),
      );
      const cutter = arena.keep(prism.subtract(underneath));
      const insertCutter = arena.keep(insertPrism.subtract(underneath));
      const insert = tag(arena.keep(top.intersect(insertCutter)), layer);
      base = arena.keep(base.subtract(cutter));
      base = arena.keep(base.add(insert));
    };
    const parsed = parseElements(input.osmData.elements, bbox, scale);
    if (parsed.undergroundBuildingCount)
      warnings.push(
        `${parsed.undergroundBuildingCount} bâtiment(s) ou partie(s) souterrains explicitement cartographiés ne sont pas extrudés au-dessus du terrain.`,
      );
    if (settings.features.parks.enabled) {
      if (parsed.parkOutlineIgnoredCount)
        warnings.push(
          `${parsed.parkOutlineIgnoredCount} contour(s) de parc ne sont pas assimilés à une pelouse : seules les surfaces végétalisées cartographiées sont colorées. Le sol non renseigné conserve sa couleur neutre.`,
        );
      if (parsed.parkOutlineFallbackCount)
        warnings.push(
          `${parsed.parkOutlineFallbackCount} parc(s) sont colorés à titre indicatif faute de surfaces végétalisées cartographiées ; leur contour ne décrit pas précisément les pelouses.`,
        );
    }
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
          !!building.measuredSolid ||
            (settings.features.buildings.roofs &&
              !!building.roofSurfaces?.length),
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
    const measuredGroundZ = (
      building: BuildingData,
      section: CrossSection,
    ): number => {
      const grid = input.elevationGrid;
      // A closed survey ground face is the shell's datum, not the local walking
      // surface. Moving a podium up to the highest DEM point lifts its stairs.
      if (
        (building.measuredSolid || building.roofSurfaces?.length) &&
        building.groundElevation != null &&
        settings.base.topographyEnabled &&
        terrain.gridVertices.length &&
        grid?.source?.includes("IGN")
      )
        return (
          settings.base.basePlateThicknessMm +
          (building.groundElevation - grid.minElev) *
            sf *
            settings.base.elevationExaggeration
        );
      return footprintSurfaceMaximum(
        section,
        terrain,
        settings.base.basePlateThicknessMm,
      );
    };
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
    const basinRims: {
      polygon: Polygon2D;
      tags: Record<string, string>;
      sourceId: string;
    }[] = [];
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
          if (
            water.tags.water === "basin" ||
            water.tags.landuse === "basin" ||
            water.tags.amenity === "fountain"
          )
            basinRims.push(water);
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
      } else
        laySurface(waterSection, settings.features.water.heightMm, "water");
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
      if (section) {
        if (layer === "piers")
          emboss(section, settings.features[layer].heightMm, layer);
        else laySurface(section, settings.features[layer].heightMm, layer);
      }
    }
    onProgress(28, "Construction des routes et des espaces naturels");
    let supportedStructures = 0;
    const stairs: StairFlight[] = [];
    if (settings.features.roads.enabled) {
      const roads: CrossSection[] = [];
      let groupedStairs = 0,
        estimatedStairs = 0,
        unavailableStairs = 0,
        measuredLandings = 0;
      for (const area of parsed.roadAreas) {
        const section = roadIncluded(area, input)
          ? footprint(area.polygon)
          : null;
        if (section) {
          roads.push(section);
          stats.roadCount++;
        } else stats.discardedFeatures++;
      }
      for (const road of parsed.roads) {
        if (!roadIncluded(road, input)) {
          stats.discardedFeatures++;
          continue;
        }
        if (road.roadType === "steps") {
          const reference = buildMeasuredStairReference(
            road,
            preparedBuildings.map(({ building }) => building),
            (lon, lat) =>
              projection
                .project(lon, lat)
                .map((value) => value * sf) as Point2D,
            (building, elevation) => {
              const prepared = preparedBuildings.find(
                (item) => item.building === building,
              )!;
              return (
                measuredGroundZ(building, prepared.section) +
                (elevation - building.groundElevation!) *
                  sf *
                  settings.features.buildings.buildingScale
              );
            },
            { scaleFactor: sf, fallbackSurfaceAt: terrain.surfaceAt },
          );
          let stairClip = clip;
          if (reference) {
            // Only mapped exposed floors may replace the surveyed architecture.
            // The uncovered approach remains connected to the bare-earth DEM.
            const buildingMask = footprint(reference.buildingFootprint, 0);
            const floors = combine(
              reference.walkablePolygons
                .map((poly) => footprint(poly, 0))
                .filter((part): part is CrossSection => !!part),
            );
            if (buildingMask && floors)
              stairClip = arena.keep(
                arena.keep(clip.subtract(buildingMask)).add(floors),
              );
          }
          const flight = makeStairFlight(cad, arena, road, {
            scaleFactor: sf,
            halfWidth: Math.max(
              minFeatureMm / 2,
              road.halfWidth * settings.features.roads.widthMultiplier,
            ),
            minTreadMm: minFeatureMm,
            minRiserMm: 0.12,
            foundationZ: Math.max(
              0.2,
              settings.base.basePlateThicknessMm - 0.3,
            ),
            terrainMaxZ: terrain.maxZ,
            surfaceAt: reference?.surfaceAt ?? terrain.surfaceAt,
            hasElevation: !!reference || terrain.gridVertices.length > 0,
            clip: stairClip,
          });
          if (flight) {
            stairs.push(flight);
            stats.staircaseCount++;
            stats.roadCount++;
            if (reference) measuredLandings++;
            if (flight.grouped) groupedStairs++;
            if (flight.estimatedRise || flight.estimatedCount)
              estimatedStairs++;
            continue;
          }
          unavailableStairs++;
        }
        const section = corridor(
          road.polyline,
          road.halfWidth * settings.features.roads.widthMultiplier,
        );
        if (section) {
          roads.push(section);
          stats.roadCount++;
          if (
            road.isBridge &&
            !parsed.bridges.some((bridge) =>
              road.polyline.some((point) =>
                pointInPolygon(...point, bridge.polygon.outer),
              ),
            )
          )
            supportedStructures++;
        } else stats.discardedFeatures++;
      }
      const roadSection = combine(roads);
      if (roadSection)
        laySurface(roadSection, settings.features.roads.heightMm, "roads");
      if (measuredLandings)
        warnings.push(
          `${measuredLandings} escalier(s) sont raccordés aux surfaces de circulation mesurées du relevé 3D ; les paliers hors couverture gardent l’altitude du terrain.`,
        );
      if (groupedStairs)
        warnings.push(
          `${groupedStairs} escalier(s) regroupent plusieurs marches pour conserver une profondeur imprimable et une montée d’au moins 0,12 mm ; la hauteur totale est conservée.`,
        );
      if (estimatedStairs)
        warnings.push(
          `${estimatedStairs} escalier(s) utilisent un nombre de marches ou une montée estimés lorsque ces mesures ne sont pas renseignées.`,
        );
      if (unavailableStairs)
        warnings.push(
          `${unavailableStairs} escalier(s) restent des chemins au niveau du sol : les altitudes ou dimensions disponibles ne permettent pas de relier des marches imprimables au terrain.`,
        );
    }
    if (settings.features.piers.enabled) {
      let missingBridges = 0;
      let aqueductFootprint: CrossSection | null = null;
      // This documentary profile belongs only to the identified Arceaux canal.
      // Unknown aqueducts retain their mapped outline and an explicit warning.
      const arceaux = input.osmData.elements.find(
        (element) =>
          element.type === "way" &&
          element.id === 380742761 &&
          element.tags?.bridge === "aqueduct",
      );
      if (arceaux?.geometry?.length) {
        const axis = arceaux.geometry.map(
          (point) =>
            projection
              .project(point.lon, point.lat)
              .map((value) => value * sf) as Point2D,
        );
        const length = axis
          .slice(1)
          .reduce(
            (sum, point, index) =>
              sum +
              Math.hypot(point[0] - axis[index][0], point[1] - axis[index][1]),
            0,
          );
        const terminalLength = Math.min(length, 51 * sf);
        const grid = terrain.gridVertices.length ? input.elevationGrid : null;
        const deckZ = grid
          ? settings.base.basePlateThicknessMm +
            (57.774 - grid.minElev) * sf * settings.base.elevationExaggeration
          : settings.base.basePlateThicknessMm + 21.68 * sf;
        const aqueduct = makeAqueduct(cad, arena, {
          axisPolylineMm: axis,
          sections: [
            ...(length > terminalLength + 0.001
              ? [
                  {
                    fromMm: 0,
                    toMm: length - terminalLength,
                    kind: "pitot-double" as const,
                  },
                ]
              : []),
            {
              fromMm: length - terminalLength,
              toMm: length,
              kind: "giral-terminal",
              spanCount: 3,
            },
          ],
          clip,
          surfaceAt: terrain.surfaceAt,
          terrainMaxZ: terrain.maxZ,
          foundationZ: Math.max(0.2, settings.base.basePlateThicknessMm - 0.3),
          deckZMm: deckZ,
          scaleFactor: sf,
          minFeatureMm,
        });
        if (aqueduct) {
          base = arena.keep(base.subtract(aqueduct.cutter));
          const aboveDeck = arena.keep(
            arena
              .keep(
                aqueduct.footprint.extrude(
                  Math.max(1, terrain.maxZ - deckZ + 1),
                ),
              )
              .translate([0, 0, deckZ]),
          );
          base = arena.keep(base.subtract(aboveDeck));
          solids.push(tag(aqueduct.solid, "buildings"));
          aqueductFootprint = aqueduct.footprint;
          stats.reconstructedAqueductCount++;
          stats.aqueductArchCount += aqueduct.spanCount;
          warnings.push(
            `Aqueduc des Arceaux : reconstitution documentaire approchée, ${aqueduct.largeSpanCount} grandes et ${aqueduct.smallSpanCount} petites ouvertures dans la sélection. Profil Pitot tiré du plan historique coté ; trois travées terminales Giral. Leur répartition sur 51 m est une hypothèse, les portées terminales et épaisseurs ne sont pas levées. ${grid ? "Cote du canal estimée depuis la terrasse voisine à 57,774 m IGN69, sans mesure du tablier." : "Hauteur moyenne historique 21,68 m utilisée sur le socle plat."}${aqueduct.modifiedForPrinting ? " Piles ou voûtes épaissies pour l’impression." : ""}${aqueduct.boundarySupportCount ? ` ${aqueduct.boundarySupportCount} appui(s) ajoutés au bord de coupe pour soutenir les voûtes.` : ""}`,
          );
          derivedSources.push(
            "Montpellier Méditerranée Métropole · plan historique de l’aqueduc, EstL0112-03 · domaine public · https://memonum-mediatheques.montpellier3m.fr/ark:/12148/btv1b106601010",
            "Ministère de la Culture · aqueduc Saint-Clément, PA00103609 · https://pop.culture.gouv.fr/notice/merimee/PA00103609",
          );
        }
      }
      for (const bridge of parsed.bridges) {
        const section = footprint(bridge.polygon);
        if (!section) {
          stats.discardedFeatures++;
          continue;
        }
        if (
          aqueductFootprint &&
          /aqueduc.*arceaux/i.test(bridge.tags.name ?? "") &&
          !arena.keep(section.intersect(aqueductFootprint)).isEmpty()
        )
          continue;
        const contains = (point: Point2D) =>
          pointInPolygon(...point, bridge.polygon.outer) &&
          !bridge.polygon.holes.some((ring) => pointInPolygon(...point, ring));
        // The mapped carried road identifies the span axis; a principal axis of
        // the outline could instead follow the underpass and rotate the vault.
        const segments = parsed.roads
          .filter((road) => road.isBridge)
          .flatMap((road) =>
            road.polyline.slice(1).map((end, i) => {
              const start = road.polyline[i];
              return {
                center: [
                  (start[0] + end[0]) / 2,
                  (start[1] + end[1]) / 2,
                ] as Point2D,
                axis: [end[0] - start[0], end[1] - start[1]] as Point2D,
              };
            }),
          )
          .filter((segment) => contains(segment.center))
          .sort((a, b) => Math.hypot(...b.axis) - Math.hypot(...a.axis));
        const segment = segments[0];
        const span = parseLengthMeters(bridge.tags["printmap:bridge_span"]);
        const clearance = parseLengthMeters(
          bridge.tags["printmap:bridge_clearance"],
        );
        const surveyedDeck = parseLengthMeters(
          bridge.tags["printmap:bridge_deck_elevation"],
        );
        const profile = bridge.tags["printmap:bridge_profile"]?.toLowerCase();
        const grid = terrain.gridVertices.length ? input.elevationGrid : null;
        const deckZ =
          surveyedDeck != null && grid
            ? settings.base.basePlateThicknessMm +
              (surveyedDeck - grid.minElev) *
                sf *
                settings.base.elevationExaggeration
            : footprintSurfaceMaximum(
                section,
                terrain,
                settings.base.basePlateThicknessMm,
              );
        const foundationZ = Math.max(
          0.2,
          settings.base.basePlateThicknessMm - 0.3,
        );
        const approach =
          segment && span && grid && profile?.includes("anse de panier")
            ? makeMeasuredBridgeApproach(cad, arena, {
                footprint: section,
                clip,
                center: segment.center,
                axis: segment.axis,
                roads: parsed.roads,
                spanMm: span * sf,
                resolutionMm:
                  (grid.resolutionM ??
                    Math.max(width / grid.cols / sf, depth / grid.rows / sf)) *
                  sf,
                terrainMaxZ: terrain.maxZ,
                foundationZ,
                surfaceAt: terrain.surfaceAt,
              })
            : null;
        // Printing thickness must never determine the altitude of a road.
        // Sample the connected lower street outside the bridge's DEM shadow.
        const groundZ = approach?.groundZ;
        const crownThickness = Math.max(0.15, Math.min(0.4, minFeatureMm / 2));
        const arch =
          segment &&
          span &&
          clearance &&
          grid &&
          groundZ != null &&
          profile?.includes("anse de panier")
            ? makeSurveyedArch(cad, arena, {
                footprint: section,
                clip,
                center: approach!.center,
                axis: approach!.axis,
                spanMm: span * sf,
                clearanceMm: clearance * sf,
                groundZ,
                deckZ,
                foundationZ,
                minThicknessMm: crownThickness,
                profile: "basket-handle",
              })
            : null;
        if (arch) {
          base = arena.keep(base.subtract(approach!.cutter));
          base = arena.keep(base.subtract(arch.cutter));
          let floor = approach!.floorSolid;
          if (settings.features.roads.enabled) {
            const lowerRoads = parsed.roads.filter(
              (road) =>
                approach!.sourceIds.includes(road.sourceId) &&
                roadIncluded({ ...road, isUnderground: false }, input),
            );
            const roadSections = lowerRoads.flatMap((road) => {
              const shape = corridor(
                road.polyline,
                road.halfWidth * settings.features.roads.widthMultiplier,
              );
              return shape ? [shape] : [];
            });
            const roadSection = combine(roadSections);
            if (roadSection) {
              const prism = arena.keep(roadSection.extrude(terrain.maxZ + 1));
              const underneath = arena.keep(floor.translate([0, 0, -0.3]));
              const skin = arena.keep(
                arena.keep(floor.intersect(prism)).subtract(underneath),
              );
              floor = arena.keep(floor.subtract(skin));
              base = arena.keep(base.add(tag(skin, "roads")));
              const restored = lowerRoads.filter(
                (road) => road.isUnderground,
              ).length;
              stats.roadCount += restored;
              stats.discardedFeatures -= restored;
            }
          }
          base = arena.keep(base.add(tag(floor, "basePlate")));
          // The DEM can smooth over the bridge. Its material above the surveyed
          // deck must be removed as well, otherwise it hides the reconstructed
          // vault and changes the documented deck elevation and thickness.
          const aboveDeck = arena.keep(
            arena
              .keep(section.extrude(Math.max(1, terrain.maxZ - deckZ + 1)))
              .translate([0, 0, deckZ]),
          );
          base = arena.keep(base.subtract(aboveDeck));
          let bridgeSolid = arch.solid;
          if (settings.features.roads.enabled) {
            const carriedRoads = parsed.roads.filter(
              (road) => road.isBridge && roadIncluded(road, input),
            );
            const shapes = carriedRoads.flatMap((road) => {
              const shape = corridor(
                road.polyline,
                road.halfWidth * settings.features.roads.widthMultiplier,
              );
              return shape ? [arena.keep(shape.intersect(section))] : [];
            });
            const roadSection = combine(shapes);
            if (roadSection && !roadSection.isEmpty()) {
              const skin = arena.keep(
                arena
                  .keep(
                    arch.solid.intersect(
                      arena.keep(roadSection.extrude(deckZ + 1)),
                    ),
                  )
                  .trimByPlane([0, 0, 1], deckZ - 0.3),
              );
              bridgeSolid = arena.keep(bridgeSolid.subtract(skin));
              solids.push(tag(skin, "roads"));
            }
          }
          solids.push(tag(bridgeSolid, "buildings"));
          stats.reconstructedBridgeCount++;
          warnings.push(
            `${bridge.tags.name ?? "Pont"} : voûte reconstituée à partir de la portée (${span} m) et du passage (${clearance} m) documentés. Courbure elliptique approchée ; couronne minimale ${crownThickness} mm. Sol du boulevard et raccords estimés depuis ${approach!.sampleCount} points du terrain hors pont, pente ${approach!.slopePercent.toFixed(2)} %, correction limitée au passage et à ses accès. ${surveyedDeck != null ? `Cote du tablier IGN ${surveyedDeck} m, incertitude ${bridge.tags["printmap:bridge_deck_uncertainty"] ?? "non renseignée"} m.` : "Cote du tablier estimée depuis le relief."}`,
          );
        } else {
          laySurface(section, 0, "piers");
          missingBridges++;
        }
      }
      if (missingBridges)
        warnings.push(
          `${missingBridges} pont(s) ou aqueduc(s) sont représentés par leur emprise au sol : les données ne fournissent pas de voûtes reconstructibles. Le contour ne représente pas leur volume architectural.`,
        );
    }
    if (settings.features.buildings.enabled) {
      let flattenedRoofs = 0;
      let approximateRoofs = 0;
      let unavailableMeasuredRoofs = 0;
      let unavailableLidarRoofs = 0;
      let unavailableStructures = 0;
      let repairedStructureSeams = 0;
      let repairedBuildingContacts = 0;
      let replacedSurveyedFoundations = 0;
      let replacedRoofFoundations = 0;
      const measuredRoofGroundCuts: Manifold[] = [];
      for (let i = 0; i < preparedBuildings.length; i++) {
        const { building, section, height } = preparedBuildings[i];
        const polygons = section.toPolygons();
        const surfaceZ = measuredGroundZ(building, section);
        const startZ = Math.max(0.2, settings.base.basePlateThicknessMm - 0.3);
        const hasMeasuredRoof =
          settings.features.buildings.roofs && !!building.roofSurfaces?.length;
        let sourceRepairs = 0;
        let measuredSolid =
          building.measuredSolid && building.groundElevation != null
            ? makeMeasuredSolid(cad, arena, building.measuredSolid, {
                groundElevation: building.groundElevation,
                project: projection.project,
                scaleFactor: sf,
                buildingScale: settings.features.buildings.buildingScale,
                surfaceZ,
                foundationZ: startZ,
                minimumHeight: minBuildingHeightMm,
                clip,
                onRepair: (count) => {
                  sourceRepairs += count;
                },
              })
            : null;
        const isMeasuredStructure = !!measuredSolid;
        const measuredRoofFootprint =
          !measuredSolid && hasMeasuredRoof && building.measuredSolid
            ? makeMeasuredRoofFallbackFootprint(
                cad,
                arena,
                building.measuredSolid,
                { project: projection.project, scaleFactor: sf, clip },
              )
            : null;
        measuredSolid ??=
          hasMeasuredRoof && building.groundElevation != null
            ? building.tags["printmap:roof_reconstruction"] === "lidar"
              ? makeLidarRoof(cad, arena, building.roofSurfaces!, {
                  groundElevation: building.groundElevation,
                  project: projection.project,
                  scaleFactor: sf,
                  buildingScale: settings.features.buildings.buildingScale,
                  surfaceZ,
                  foundationZ: startZ,
                  footprint: measuredRoofFootprint ?? section,
                  minimumHeight: minBuildingHeightMm,
                  fitToleranceM:
                    parseLengthMeters(
                      building.tags["printmap:roof_fit_tolerance_m"],
                    ) ??
                    0.35 +
                      (parseLengthMeters(
                        building.tags["printmap:roof_resolution_m"],
                      ) ??
                        input.report?.lidarRoofResolutionM ??
                        2) *
                        0.12,
                })
              : makeMeasuredRoof(
                  cad,
                  arena,
                  building.roofSurfaces!,
                  building.groundElevation,
                  projection.project,
                  sf,
                  settings.features.buildings.buildingScale,
                  surfaceZ,
                  startZ,
                  measuredRoofFootprint ?? section,
                  minBuildingHeightMm,
                )
            : null;
        if (measuredSolid) {
          try {
            const stabilized = stabilizeSolid(cad, arena, measuredSolid);
            const pieces = stabilized
              .decompose()
              .map((piece) => arena.keep(piece));
            const supported = pieces.filter(
              (piece) => piece.volume() > 0.000001,
            );
            if (
              !supported.length ||
              supported.some(
                (piece) => piece.boundingBox().min[2] > startZ + 0.0001,
              )
            )
              measuredSolid = null;
            else {
              let printable = removeNumericalShells(
                cad,
                arena,
                stabilized,
                (piece) => Math.abs(piece.volume()) > 0.000001,
              );
              const repairVolume = printable.volume();
              const uncutSurvey = printable;
              let removedVolume = 0;
              let localContacts = 0;
              let useContactBounds = false;
              let closed = false;
              let failure: unknown;
              // Converting a local cut back to Float32 can expose a second
              // contact, as on Sainte-Anne at a 200 mm neighbourhood scale.
              // Check the actual boundary after each of three bounded passes,
              // rather than replacing its nave by the bell tower's height.
              for (let pass = 0; pass < 3; pass++) {
                const beforeVolume = printable.volume();
                const localRepair = openEdgeContacts(
                  cad,
                  arena,
                  printable,
                  0.005,
                  useContactBounds
                    ? { coplanarFootprint: "bounds" }
                    : undefined,
                );
                localContacts += localRepair.repairedCount;
                if (localRepair.repairedCount) {
                  const repaired = arena.keep(
                    new cad.Manifold(
                      repairNumericalTriangles(
                        cad,
                        repairCollinear(
                          cad,
                          repairCoincident(cad, localRepair.solid.getMesh()),
                        ),
                      ),
                    ),
                  );
                  printable = removeNumericalShells(
                    cad,
                    arena,
                    repaired,
                    (piece) => Math.abs(piece.volume()) > 0.000001,
                  );
                }
                removedVolume += Math.max(0, beforeVolume - printable.volume());
                if (
                  removedVolume >
                  repairVolume * 0.0001 +
                    3 * Math.max(0.000001, repairVolume * 0.00000001)
                )
                  throw new Error(
                    "La réparation du relevé dépasse la précision autorisée.",
                  );
                try {
                  validatePrintMesh(extractMesh(printable, new Map()));
                  closed = true;
                  break;
                } catch (error) {
                  failure = error;
                }
                if (pass > 0 && !localRepair.repairedCount) {
                  if (
                    pass === 1 &&
                    failure instanceof Error &&
                    /face collinéaire/.test(failure.message)
                  ) {
                    // A face-shaped cut can leave a collinear Float32 sliver
                    // without a remaining contact to cut. Use the last attempt
                    // for the bounded footprint, starting from the immutable
                    // survey rather than accumulating cuts on that candidate.
                    printable = uncutSurvey;
                    useContactBounds = true;
                    // The abandoned candidate contributes no material changes
                    // or reported contacts to the ultimately retained survey.
                    removedVolume = 0;
                    localContacts = 0;
                    continue;
                  }
                  break;
                }
              }
              if (!closed) throw failure;
              const repairedPieces = printable
                .decompose()
                .map((piece) => arena.keep(piece));
              if (
                repairedPieces.some(
                  (piece) =>
                    piece.volume() > 0.000001 &&
                    piece.boundingBox().min[2] > startZ + 0.0001,
                )
              )
                throw new Error(
                  "La réparation du relevé a laissé des détails sans fondation.",
                );
              measuredSolid = printable;
              repairedBuildingContacts += localContacts;
            }
          } catch {
            measuredSolid = null;
          }
        }
        if (building.measuredSolid && (!measuredSolid || !isMeasuredStructure))
          unavailableStructures++;
        if (hasMeasuredRoof && !measuredSolid) {
          if (building.tags["printmap:roof_reconstruction"] === "lidar")
            unavailableLidarRoofs++;
          else unavailableMeasuredRoofs++;
        }
        const explicitRoof = settings.features.buildings.roofs
          ? building.tags["roof:shape"]?.trim().toLowerCase()
          : undefined;
        const canRoof = !!explicitRoof && building.roofShape !== "flat";
        const roofHeight = canRoof
          ? Math.min(
              height,
              building.roofHeight * settings.features.buildings.buildingScale,
            )
          : 0;
        const wallTop = surfaceZ + height - roofHeight;
        // Full foundation through the underlying terrain supports every building.
        let solid =
          measuredSolid ??
          arena.keep(
            arena
              .keep(section.extrude(wallTop - startZ))
              .translate([0, 0, startZ]),
          );
        if (measuredSolid) {
          if (building.tags["printmap:roof_reconstruction"] === "lidar")
            stats.lidarRoofCount = (stats.lidarRoofCount ?? 0) + 1;
          else stats.realRoofCount++;
          if (isMeasuredStructure) stats.measuredStructureCount++;
          if (isMeasuredStructure) repairedStructureSeams += sourceRepairs;
          if (isMeasuredStructure) {
            // The surveyed support footprint owns its ground. Letting the DEM
            // run through a podium fabricates thin terrain/wall contact films.
            // Use only explicit ground faces, including their holes; neither a
            // roof projection nor the underside of a vault defines an abutment.
            const supports = building
              .measuredSolid!.surfaces.filter(
                (surface) => surface.kind === "ground",
              )
              .map((surface) =>
                arena.keep(
                  new cad.CrossSection(
                    [
                      surface.outer.map(
                        (point) =>
                          projection
                            .project(point.lon, point.lat)
                            .map((value) => value * sf) as Point2D,
                      ),
                      ...surface.holes.map((ring) =>
                        ring.map(
                          (point) =>
                            projection
                              .project(point.lon, point.lat)
                              .map((value) => value * sf) as Point2D,
                        ),
                      ),
                    ],
                    "EvenOdd",
                  ),
                ),
              )
              .filter((shape) => !shape.isEmpty());
            if (supports.length) {
              const support = arena.keep(
                arena
                  .keep(cad.CrossSection.union(supports))
                  .offset(0.005, "Miter"),
              );
              const bounded = arena.keep(support.intersect(clip));
              const cutter = arena.keep(
                arena
                  .keep(bounded.extrude(terrain.maxZ + 1))
                  .translate([0, 0, startZ + 0.01]),
              );
              base = arena.keep(base.subtract(cutter));
              replacedSurveyedFoundations++;
            }
          } else if (
            building.groundElevation != null &&
            settings.base.topographyEnabled &&
            terrain.gridVertices.length &&
            input.elevationGrid?.source?.includes("IGN")
          ) {
            // A coarse terrain cell may be higher than a measured low roof.
            // The survey floor owns only its actual support footprint. Preserve
            // courtyards and surrounding ground, and leave roof elevations intact.
            const supports = building.measuredSolid
              ? building.measuredSolid.surfaces
                  .filter((surface) => surface.kind === "ground")
                  .map((surface) =>
                    arena.keep(
                      new cad.CrossSection(
                        [surface.outer, ...surface.holes].map((ring) =>
                          ring.map(
                            (point) =>
                              projection
                                .project(point.lon, point.lat)
                                .map((value) => value * sf) as Point2D,
                          ),
                        ),
                        "EvenOdd",
                      ),
                    ),
                  )
                  .filter((shape) => !shape.isEmpty())
              : [section];
            if (supports.length) {
              const support = arena.keep(
                arena
                  .keep(cad.CrossSection.union(supports))
                  .offset(0.005, "Miter"),
              );
              const bounded = arena.keep(support.intersect(clip));
              const cutter = arena.keep(
                arena
                  .keep(bounded.extrude(terrain.maxZ + 1))
                  .translate([0, 0, Math.max(startZ + 0.01, surfaceZ)]),
              );
              const lowestRoof = building.roofSurfaces!.reduce(
                (lowest, surface) =>
                  surface.outer.reduce(
                    (height, point) => Math.min(height, point.elevation),
                    lowest,
                  ),
                Infinity,
              );
              const lowestRoofZ =
                surfaceZ +
                (lowestRoof - building.groundElevation) *
                  sf *
                  settings.features.buildings.buildingScale;
              if (
                footprintSurfaceMaximum(bounded, terrain, startZ) >
                lowestRoofZ + 0.000001
              ) {
                measuredRoofGroundCuts.push(cutter);
                replacedRoofFoundations++;
              }
            }
          }
        } else if (canRoof && roofHeight > 0.02) {
          const roof = makeRoof(
            cad,
            arena,
            building,
            polygons,
            wallTop,
            roofHeight,
            building.roofShape,
          );
          const prism = arena.keep(
            arena
              .keep(section.extrude(roofHeight + 0.1))
              .translate([0, 0, wallTop - 0.03]),
          );
          solid = arena.keep(solid.add(arena.keep(roof.intersect(prism))));
          stats.taggedRoofCount++;
          if (
            building.polygon.holes.length ||
            building.classification.footprintClass === "complex" ||
            (!building.tags["roof:height"] &&
              !building.tags["roof:levels"] &&
              !building.tags["roof:angle"])
          )
            approximateRoofs++;
        } else if (explicitRoof && explicitRoof !== "flat") flattenedRoofs++;
        if (
          measuredSolid &&
          !isMeasuredStructure &&
          preparedBuildings.length > 1
        ) {
          // Survey roof envelopes can touch neighbouring buildings on a single
          // vertical edge. Give them five microns of horizontal overlap, without
          // changing roof altitudes, so the final union has a finite junction.
          // Complete architectural shells keep their source floor masks and
          // openings: stretching those would misalign the measured stair cuts.
          const sourceEnvelope = solid;
          const bounds = solid.boundingBox();
          const cx = (bounds.min[0] + bounds.max[0]) / 2;
          const cy = (bounds.min[1] + bounds.max[1]) / 2;
          const sx = 1 + 0.01 / Math.max(0.1, bounds.max[0] - bounds.min[0]);
          const sy = 1 + 0.01 / Math.max(0.1, bounds.max[1] - bounds.min[1]);
          solid = arena.keep(
            solid.warp((vertex) => {
              vertex[0] = cx + (vertex[0] - cx) * sx;
              vertex[1] = cy + (vertex[1] - cy) * sy;
            }),
          );
          const boundary = arena.keep(clip.extrude(bounds.max[2] + 1));
          solid = arena.keep(solid.intersect(boundary));
          try {
            validatePrintMesh(extractMesh(solid, new Map()));
          } catch {
            // Float32 clipping can close a micron-scale gap between separate
            // roof wings. Keep the already validated survey in that case;
            // the optional overlap must not damage its source topology.
            solid = sourceEnvelope;
          }
        }
        // A clipped survey may have several separate roof envelopes, each
        // supported by the common socle. Submit those as independent operands:
        // a compound native operand can otherwise retain a closed terrain seam
        // as a detached roof at the selection boundary. Architectural shells
        // and envelopes containing negative cavity boundaries stay together.
        const roofParts =
          measuredSolid && !isMeasuredStructure
            ? solid.decompose().map((part) => arena.keep(part))
            : [];
        if (
          roofParts.length > 1 &&
          roofParts.every((part) => part.volume() > 0) &&
          roofParts.some((part) => {
            const bounds = part.boundingBox();
            return [
              bounds.min[0] + width / 2,
              width / 2 - bounds.max[0],
              bounds.min[1] + depth / 2,
              depth / 2 - bounds.max[1],
            ].some((distance) => Math.abs(distance) <= 0.0001);
          })
        ) {
          // A boundary alone does not justify changing the native operands.
          // Verify that their compound union really retains a detached roof
          // above the socle, as on B144777's clipped low northern panel. Other
          // wings, including B140305's narrow north gap, remain together.
          const surveyUnion = base.add(solid);
          let detachedRoof = false;
          try {
            const surveyedComponents = surveyUnion.decompose();
            try {
              detachedRoof = surveyedComponents.some(
                (component) =>
                  component.volume() > 0.000001 &&
                  component.boundingBox().min[2] > startZ + 0.0001,
              );
            } finally {
              for (const component of surveyedComponents) component.delete();
            }
          } finally {
            surveyUnion.delete();
          }
          if (detachedRoof)
            for (const part of roofParts) solids.push(tag(part, "buildings"));
          else solids.push(tag(solid, "buildings"));
        } else solids.push(tag(solid, "buildings"));
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
      if (measuredRoofGroundCuts.length)
        base = arena.keep(
          base.subtract(arena.keep(cad.Manifold.union(measuredRoofGroundCuts))),
        );
      if (unavailableStructures)
        warnings.push(
          `${unavailableStructures} coque(s) 3D mesurée(s) n’ont pas pu être fermées. Le repli conserve les toitures mesurées lorsqu’elles sont utilisables et leurs fondations ; les ouvertures et dessous ne sont pas reproduits par ce repli.`,
        );
      if (repairedStructureSeams)
        warnings.push(
          `${repairedStructureSeams} joint(s) ouverts du relevé 3D ont été fermés dans un plan déjà couvert par une face de la source ; les traversées architecturales sont conservées.`,
        );
      if (repairedBuildingContacts)
        warnings.push(
          `${repairedBuildingContacts} contact(s) de précision dans les relevés de bâtiments ont été ouverts localement sur 0,005 mm, en trois passages au maximum et avec un retrait cumulé limité à 0,01 % du volume de chaque relevé, pour conserver leurs toitures détaillées. Les cavités sont conservées.`,
        );
      if (replacedSurveyedFoundations)
        warnings.push(
          `${replacedSurveyedFoundations} appui(s) de coques mesurées remplacent le terrain sous leurs seules faces de fondation, avec raccord de précision de 0,005 mm. Les trous et passages architecturaux sont conservés.`,
        );
      if (replacedRoofFoundations)
        warnings.push(
          `${replacedRoofFoundations} emprise(s) de bâtiments à toiture 3D remplacent le terrain grossier au-dessus de leur sol sourcé. Les cours et le terrain extérieur sont conservés ; les altitudes des toits ne sont pas modifiées.`,
        );
      if (flattenedRoofs)
        warnings.push(
          `${flattenedRoofs} forme(s) de toiture non prise(s) en charge représentée(s) à plat.`,
        );
      if (approximateRoofs)
        warnings.push(
          `${approximateRoofs} toiture(s) suivent une forme renseignée avec des dimensions ou une implantation des pentes approximatives.`,
        );
      if (unavailableMeasuredRoofs)
        warnings.push(
          `${unavailableMeasuredRoofs} toiture(s) mesurée(s) incomplète(s) ou invalide(s) utilisent la représentation de repli renseignée dans les données.`,
        );
      if (unavailableLidarRoofs)
        warnings.push(
          `${unavailableLidarRoofs} reconstruction(s) de toiture LiDAR incompatibles avec le solide imprimable utilisent la représentation de repli renseignée dans les données.`,
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
    for (const basin of basinRims) {
      const outer = cleanRing(basin.polygon.outer);
      if (outer.length < 3) continue;
      // Keep the uncut water outline: a selection edge is not a basin wall.
      const section = arena.keep(
        new cad.CrossSection(
          [
            outer,
            ...basin.polygon.holes
              .map(cleanRing)
              .filter((ring) => ring.length >= 3),
          ],
          "EvenOdd",
        ),
      );
      const documentedHeight =
        basin.tags.barrier === "wall"
          ? parseLengthMeters(basin.tags.height)
          : null;
      const documentedWidth = parseLengthMeters(basin.tags["wall:width"]);
      const rim = makeBasinRim(cad, arena, {
        footprint: section,
        clip,
        terrainSolid: terrain.solid,
        terrainMaxZ: terrain.maxZ,
        foundationZ: Math.max(0.2, settings.base.basePlateThicknessMm - 0.3),
        widthMm: (documentedWidth ?? 0) * sf,
        heightMm: (documentedHeight ?? 0) * sf,
        minWidthMm: Math.max(0.4, minFeatureMm / 2),
        minHeightMm: 0.12,
      });
      if (rim) {
        solids.push(tag(rim.solid, "buildings"));
        stats.basinRimCount++;
        warnings.push(
          `Bassin ${basin.sourceId} : bordure sur le contour cartographié, largeur ${rim.widthMm.toFixed(2)} mm et hauteur ${rim.heightMm.toFixed(2)} mm dans la maquette. ${documentedHeight != null ? `Hauteur du mur renseignée ${documentedHeight} m ; ` : "Hauteur non renseignée ; "}${documentedWidth == null ? "largeur estimée ; " : ""}${rim.adjustedDimensions ? "dimensions adaptées pour l’impression." : "dimensions renseignées."}`,
        );
      }
    }
    onProgress(72, "Fusion du socle et des détails en un seul solide");
    // Preserve the mixed terrain palette while limiting each added layer's
    // ancestry before decomposing the many zero-volume DEM boundary shells.
    const layerSolids = preparePrintLayers(cad, arena, solids, materialIds);
    let union = arena.keep(cad.Manifold.union([base, ...layerSolids]));
    // Carve source ramp faces after adding the surveyed shells, so the source
    // ramps cannot cover the printable treads built on the same landings.
    if (stairs.length) {
      // Apply the replacement footprints together. Repeated alternating cuts
      // and unions build a deep native operation history on dense city meshes.
      const stairCutters = arena.keep(
        cad.Manifold.union(stairs.map((flight) => flight.cutter)),
      );
      union = arena.keep(union.subtract(stairCutters));
      union = arena.keep(
        cad.Manifold.union([
          union,
          ...stairs.map((flight) => tag(flight.solid, "roads")),
        ]),
      );
    }
    // Remove numerical sheets before Float32 contraction can give their
    // coincident opposite faces a spurious volume. Their effective thickness
    // is below one coordinate step of the Float32 export, not printable matter.
    const coordinateStep = Math.max(
      0.00001,
      Math.max(width, depth, terrain.maxZ) * 0.00000012,
    );
    const hasMaterial = (component: Manifold) =>
      Math.abs(component.volume()) >
      Math.max(0.000001, component.surfaceArea() * coordinateStep);
    const cleanUnion = removeNumericalShells(cad, arena, union, hasMaterial);
    // The renderer/STL stores Float32 coordinates. Remove intersections smaller
    // than a micron before conversion so they cannot collapse into zero-area faces.
    const merged = stabilizeSolid(cad, arena, cleanUnion, 0.001, true);
    if (merged.status() !== "NoError" || merged.isEmpty())
      throw new Error(
        "Le moteur n’a pas pu produire un solide fermé. Réduisez la zone ou choisissez un profil plus épuré.",
      );
    const components = merged.decompose();
    for (const component of components) arena.keep(component);
    // Coplanar boolean intersections can leave topological zero-volume shells.
    // They carry no printable material and must not become detached mesh faces.
    // Internal voids have negative oriented boundary shells. They are not
    // detached pieces and must remain in the original solid and export.
    const underResolution = (component: Manifold): boolean => {
      const volume = component.volume();
      if (volume <= 0 || volume >= minFeatureMm ** 3) return false;
      const bounds = component.boundingBox();
      return (
        bounds.min[2] > 0.001 &&
        Math.min(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        ) < minFeatureMm
      );
    };
    const retained = (component: Manifold) =>
      hasMaterial(component) && !underResolution(component);
    const omittedFragments = components.filter(
      (component) => hasMaterial(component) && underResolution(component),
    ).length;
    if (omittedFragments) {
      stats.discardedFeatures += omittedFragments;
      warnings.push(
        `${omittedFragments} fragment(s) détaché(s) sous la résolution d’impression (${minFeatureMm} mm) ont été écartés. Les cavités des monuments sont conservées.`,
      );
    }
    stats.components = components.filter(
      (component) => retained(component) && component.volume() > 0,
    ).length;
    if (stats.components !== 1)
      throw new Error(
        "Le modèle contient des détails détachés du socle. Réduisez la zone ou désactivez les détails concernés.",
      );
    let result = removeNumericalShells(cad, arena, merged, retained);
    // Shell concatenation retains separate native vertex identities. Opposite
    // boundaries can then coincide at Float32 export precision, as at the
    // Vialleton outlet. Cancel those zero-thickness sheets before cutting a
    // supposed contact: otherwise the unnecessary cut moves the singularity
    // onto the terrace and creates further numerical triangles. Negative
    // cavity shells keep their winding; no cavity is filled by this cleanup.
    result = removeCoincidentSheets(cad, arena, result);
    const repairVolume = result.volume();
    let removedVolume = 0;
    let contactRepairs = 0;
    let mesh: PrintMesh | undefined;
    let failure: unknown;
    for (let pass = 0; pass < 3; pass++) {
      const beforeVolume = result.volume();
      const contactRepair = openEdgeContacts(cad, arena, result, 0.005, {
        // Only terrain/road films require the full coplanar face bounds.
        // Roofs keep their smaller face footprints and the same volume guards.
        // Native source IDs are mapped to layers, never treated as layer indices.
        coplanarFootprint: (originalId) => {
          const layer = materialIds.get(originalId) ?? "basePlate";
          return layer === "basePlate" || layer === "roads"
            ? "bounds"
            : "faces";
        },
        lineContactSegments: 4,
      });
      contactRepairs += contactRepair.repairedCount;
      // Check the actual Float32 export after each local cut. Its new vertices
      // can expose another contact, as on the clipped Comedie roof. Keep the
      // same clearance and total material budget; never simplify these cuts.
      const recleaned = arena.keep(
        new cad.Manifold(
          repairCollinear(
            cad,
            // Contract a submicron edge before retriangulating a collinear
            // sheet. Reversing these operations lets CAD recreate a tiny face
            // at touching surveyed roof corners after the contact was opened.
            repairNumericalTriangles(
              cad,
              repairCoincident(cad, contactRepair.solid.getMesh()),
            ),
          ),
        ),
      );
      if (recleaned.status() !== "NoError")
        throw new Error("La fermeture numérique du modèle a échoué.");
      result = removeNumericalShells(cad, arena, recleaned, retained);
      removedVolume += Math.max(0, beforeVolume - result.volume());
      if (
        removedVolume >
        repairVolume * 0.0001 +
          3 * Math.max(0.000001, repairVolume * 0.00000001)
      )
        throw new Error(
          "La réparation du modèle dépasse la précision autorisée.",
        );
      const repairedPieces = result.decompose();
      stats.components = repairedPieces.filter(
        (piece) => piece.volume() > 0.000001,
      ).length;
      for (const piece of repairedPieces) piece.delete();
      if (stats.components !== 1)
        throw new Error(
          "La réparation locale a laissé des détails détachés du socle.",
        );
      const candidate = extractMesh(result, materialIds);
      try {
        validatePrintMesh(candidate);
        mesh = candidate;
        break;
      } catch (error) {
        failure = error;
      }
      if (pass > 0 && !contactRepair.repairedCount) break;
    }
    if (!mesh) throw failure;
    if (contactRepairs)
      warnings.push(
        `${contactRepairs} contact(s) de précision ont été ouverts localement sur 0,005 mm, en trois passages au maximum et avec un retrait cumulé limité à 0,01 % du volume du modèle. Les cavités sont conservées.`,
      );
    stats.volumeMm3 = result.volume();
    const bounds = result.boundingBox();
    stats.triangleCount = mesh.indices.length / 3;
    const tiles: PrintTile[] = [];
    let tileContactRepairs = 0;
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
          // Prefer the tighter cut tolerance to conserve the repaired parent.
          // Complex surveyed intersections can need its one-micron tolerance;
          // either result must pass the same strict exported-mesh validation.
          const finishCut = (tolerance: number): PrintMesh => {
            // Translation changes Float32 rounding. Stabilize the coordinates
            // that will actually be exported, including tiny cut intersections.
            const localCut = arena.keep(
              cut.translate([-minX - tileWidth / 2, -minY - tileDepth / 2, 0]),
            );
            // Keep the parent's native plane tolerance at the cut boundary.
            // Widening it to the requested contraction bound can lower a real
            // surveyed roof and create contacts absent from the native cut.
            let tile = stabilizeSolid(cad, arena, localCut, tolerance, true);
            if (tile.status() !== "NoError" || tile.isEmpty())
              throw new Error("Échec de la fermeture d’une tuile.");
            const repairVolume = tile.volume();
            let removedVolume = 0;
            let repairedContacts = 0;
            let failure: unknown;
            // A local cut can expose another contact when its new vertices are
            // rounded to Float32. Keep the same five-micron clearance and total
            // removal budget across at most three strictly checked passes.
            for (let pass = 0; pass < 3; pass++) {
              const beforeVolume = tile.volume();
              const repair = openEdgeContacts(cad, arena, tile);
              repairedContacts += repair.repairedCount;
              const closed = arena.keep(
                new cad.Manifold(
                  repairNumericalTriangles(
                    cad,
                    repairCollinear(
                      cad,
                      repairCoincident(cad, repair.solid.getMesh()),
                    ),
                  ),
                ),
              );
              tile = removeNumericalShells(cad, arena, closed, retained);
              removedVolume += Math.max(0, beforeVolume - tile.volume());
              if (
                removedVolume >
                repairVolume * 0.0001 +
                  3 * Math.max(0.000001, repairVolume * 0.00000001)
              )
                throw new Error(
                  "La réparation d’une tuile dépasse la précision autorisée.",
                );
              const output = extractMesh(tile, materialIds);
              try {
                validatePrintMesh(output);
                tileContactRepairs += repairedContacts;
                return output;
              } catch (error) {
                failure = error;
              }
              if (pass > 0 && !repair.repairedCount) break;
            }
            throw failure;
          };
          let tileMesh: PrintMesh;
          try {
            tileMesh = finishCut(0.0001);
          } catch {
            tileMesh = finishCut(0.001);
          }
          tiles.push({
            ...tileMesh,
            col,
            row,
            widthMm: tileWidth,
            depthMm: tileDepth,
          });
        }
    }
    if (tileContactRepairs)
      warnings.push(
        `${tileContactRepairs} contact(s) de précision ont été ouverts localement dans les tuiles sur 0,005 mm, en trois passages au maximum et avec un retrait cumulé limité à 0,01 % du volume de chaque tuile. Les cavités sont conservées.`,
      );
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
      sources: [...new Set([...buildSources(input), ...derivedSources])],
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
  for (const element of input.osmData.elements) {
    if (element.roofSource && element.roofSurfaces?.length)
      sources.push(element.roofSource);
    if (element.measuredSolid?.source)
      sources.push(element.measuredSolid.source);
    if (element.tags?.["printmap:structure_source"])
      sources.push(element.tags["printmap:structure_source"]);
    if (element.tags?.["printmap:bridge_deck_source"])
      sources.push(element.tags["printmap:bridge_deck_source"]);
  }
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
  if (sources.some((source) => /Montpellier.*CityGML/.test(source)))
    sources.push(
      "Montpellier Méditerranée Métropole — bâtiments 3D 2020 · ODbL · https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier",
    );
  if (sources.some((source) => /Montpellier.*ouvrages/.test(source)))
    sources.push(
      "Montpellier Méditerranée Métropole — ouvrages d’art · ODbL · https://data.montpellier3m.fr/dataset/ouvrages-dart-de-montpellier-mediterranee-metropole",
    );
  if (sources.some((source) => /Open-Meteo|Copernicus/.test(source)))
    sources.push(
      "Copernicus DEM GLO-90 via Open-Meteo · https://open-meteo.com/en/docs/elevation-api · https://doi.org/10.5270/ESA-c5d3d65",
    );
  return [...new Set(sources)];
}
