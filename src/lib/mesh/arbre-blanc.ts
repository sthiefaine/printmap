import type {
  CrossSection,
  Manifold,
  ManifoldToplevel,
  Mesh,
} from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { RoofSurface } from "@/types/osm";
import observed from "../data/arbre-blanc-lidar.json";
import { repairCoincident } from "./repair-coincident";
import { repairNumericalTriangles } from "./repair-numerical-triangles";
import { repairCollinear } from "./repair-collinear";
import { contractShortEdges } from "./contract-short-edges";
import { removeNumericalShells } from "./retain-shells";
import { openEdgeContacts } from "./open-edge-contacts";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
interface GeographicPolygon {
  outer: { lat: number; lon: number }[];
  holes: { lat: number; lon: number }[][];
}
export interface ArbreBlancOptions {
  surfaces: RoofSurface[];
  groundElevation: number;
  project: (lon: number, lat: number) => Point2D;
  scaleFactor: number;
  buildingScale: number;
  surfaceZ: number;
  foundationZ: number;
  footprint: CrossSection;
  clip: CrossSection;
  minimumHeight: number;
  minFeatureMm: number;
}
export interface ArbreBlancModel {
  solid: Manifold;
  observedLevelCount: number;
  retainedLevelCount: number;
  terraceCount: number;
  inferredConnectionCount: number;
  omittedFragmentCount: number;
  slabThicknessMm: number;
  repairedContactCount: number;
  repairVolumeDeltaMm3: number;
  /** Proxy facade up to the highest observed terrace, not a measured wall. */
  bodyTopElevationM: number;
  estimatedBody: true;
}

/** Source identities remain stable when a cached OSM extract is enriched again. */
export function isArbreBlanc(sourceId: string | undefined): boolean {
  return sourceId === "MMM/B102558" || sourceId === "way/441634682";
}

function nearestPair(a: Point2D[][], b: Point2D[][]) {
  let distance = Infinity;
  let from: Point2D = [0, 0],
    to: Point2D = [0, 0];
  const visit = (
    point: Point2D,
    start: Point2D,
    end: Point2D,
    reverse: boolean,
  ) => {
    const dx = end[0] - start[0],
      dy = end[1] - start[1];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
          (dx * dx + dy * dy || 1),
      ),
    );
    const projected: Point2D = [start[0] + t * dx, start[1] + t * dy];
    const d = Math.hypot(point[0] - projected[0], point[1] - projected[1]);
    if (d < distance) {
      distance = d;
      from = reverse ? projected : point;
      to = reverse ? point : projected;
    }
  };
  for (const ringA of a)
    for (let i = 0; i < ringA.length; i++)
      for (const ringB of b)
        for (let j = 0; j < ringB.length; j++) {
          visit(ringA[i], ringB[j], ringB[(j + 1) % ringB.length], false);
          visit(ringB[j], ringA[i], ringA[(i + 1) % ringA.length], true);
        }
  return { from, to, distance };
}

function closedBoundary(mesh: Mesh): boolean {
  const ids = new Map<string, number>();
  const vertices = new Uint32Array(mesh.vertProperties.length / mesh.numProp);
  const edges = new Map<string, { count: number; balance: number }>();
  for (let i = 0; i < vertices.length; i++) {
    const point = Array.from(
      mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3),
    );
    if (!point.every(Number.isFinite)) return false;
    const key = point.map((value) => Math.round(value * 100000)).join(",");
    if (!ids.has(key)) ids.set(key, ids.size);
    vertices[i] = ids.get(key)!;
  }
  for (let i = 0; i < mesh.triVerts.length; i += 3) {
    const indices = Array.from(mesh.triVerts.subarray(i, i + 3));
    const [a, b, c] = indices.map((index) => vertices[index]);
    if (a === b || b === c || c === a) return false;
    const [p, q, r] = indices.map((index) =>
      Array.from(
        mesh.vertProperties.subarray(
          index * mesh.numProp,
          index * mesh.numProp + 3,
        ),
      ),
    );
    const u = q.map((value, axis) => value - p[axis]),
      v = r.map((value, axis) => value - p[axis]);
    const cross = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    if (cross.reduce((sum, value) => sum + value * value, 0) <= 1e-20)
      return false;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const edge = edges.get(key) ?? { count: 0, balance: 0 };
      edge.count++;
      edge.balance += from < to ? 1 : -1;
      edges.set(key, edge);
    }
  }
  return [...edges.values()].every(
    (edge) => edge.count === 2 && edge.balance === 0,
  );
}

/**
 * Observed terrace tops and the OSM core become a printable interpretation.
 * The laser does not measure complete undersides: slab thickness and bounded
 * horizontal links are explicitly reconstructed, never claimed as LoD2 walls.
 */
export function makeArbreBlanc(
  cad: ManifoldToplevel,
  owner: Handles,
  options: ArbreBlancOptions,
): ArbreBlancModel | null {
  const {
    surfaces,
    scaleFactor: sf,
    buildingScale,
    groundElevation,
    surfaceZ,
    foundationZ,
  } = options;
  if (
    !surfaces.length ||
    ![
      sf,
      buildingScale,
      groundElevation,
      surfaceZ,
      foundationZ,
      options.minFeatureMm,
    ].every(Number.isFinite) ||
    sf <= 0 ||
    buildingScale <= 0 ||
    options.minFeatureMm <= 0
  )
    return null;
  const handles: { delete(): void }[] = [];
  const arena: Handles = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  let output: Manifold | undefined;
  try {
    // Keep the calculation near its own origin. Translation back is exact CAD;
    // the plate's projection, datum, shared border and source grid do not move.
    const bounds = options.footprint.bounds();
    const origin: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      foundationZ,
    ];
    const xy = (point: { lat: number; lon: number }): Point2D => {
      const projected = options.project(point.lon, point.lat);
      return [projected[0] * sf - origin[0], projected[1] * sf - origin[1]];
    };
    const section = (polygon: GeographicPolygon) =>
      arena.keep(
        new cad.CrossSection(
          [polygon.outer, ...polygon.holes].map((ring) => ring.map(xy)),
          "EvenOdd",
        ),
      );
    const supplied = arena.keep(
      options.footprint.translate([-origin[0], -origin[1]]),
    );
    const clip = arena.keep(options.clip.translate([-origin[0], -origin[1]]));
    const sourceFootprint = section(observed.groundFootprint);
    const footprint = arena.keep(
      arena.keep(sourceFootprint.intersect(supplied)).intersect(clip),
    );
    // An identifier on a different geographic shape cannot activate this asset.
    if (
      footprint.isEmpty() ||
      footprint.area() <
        Math.min(sourceFootprint.area(), supplied.area()) * 0.95
    )
      return null;
    const core = arena.keep(
      section(observed.coreFootprint).intersect(footprint),
    );
    if (core.isEmpty()) return null;
    if (
      surfaces.some(
        (surface) =>
          !surface.outer.length ||
          ![surface.outer, ...surface.holes].every((ring) =>
            ring.every(
              (point) => point.elevation === surface.outer[0].elevation,
            ),
          ),
      )
    )
      return null;
    const maximumElevation = Math.max(
      ...surfaces.map((surface) => surface.outer[0].elevation),
    );
    const factor =
      sf *
      buildingScale *
      Math.max(
        1,
        options.minimumHeight /
          ((maximumElevation - groundElevation) * sf * buildingScale),
      );
    const roofZ = (elevation: number) =>
      surfaceZ - origin[2] + (elevation - groundElevation) * factor;
    const sourcePanels = surfaces
      .map((surface) => ({
        shape: arena.keep(section(surface).intersect(core)),
        elevation: surface.outer[0].elevation,
      }))
      .filter(
        (panel) =>
          !panel.shape.isEmpty() &&
          panel.shape.area() >= 0.0001 &&
          // A roof outside the core can leave a point/line intersection after
          // projection. It does not define a physical core storey. Keep the
          // existing 98% coverage guard while refusing sub-half-micron strips.
          !arena.keep(panel.shape.offset(-0.0005, "Miter")).isEmpty(),
      );
    const coverage = arena.keep(
      cad.CrossSection.union(sourcePanels.map((panel) => panel.shape)),
    );
    if (
      arena.keep(core.subtract(coverage)).area() >
      Math.max(0.02, core.area() * 0.02)
    )
      return null;
    // Low CityGML RoofSurfaces describe terrace tips, not the core's facade.
    // Projecting them down the tower fabricates stepped columns. The declared
    // reconstructed facade uses the OSM core up to the highest observed laser
    // level; only source roof panels above it retain the bar/crowning profile.
    const bodyTopElevationM = Math.max(
      ...observed.levels.map((level) => level.elevationM),
    );
    const bands: { shape: CrossSection; bottom: number; top: number }[] = [
      { shape: core, bottom: 0, top: roofZ(bodyTopElevationM) },
    ];
    const coreLevels = [
      ...new Set(
        sourcePanels
          .filter((panel) => panel.elevation > bodyTopElevationM)
          .map((panel) => panel.elevation),
      ),
    ].sort((a, b) => b - a);
    let coreMask: CrossSection | undefined;
    for (let i = 0; i < coreLevels.length; i++) {
      coreMask = arena.keep(
        cad.CrossSection.union([
          ...(coreMask ? [coreMask] : []),
          ...sourcePanels
            .filter((panel) => panel.elevation === coreLevels[i])
            .map((panel) => panel.shape),
        ]),
      );
      const shape = coreMask;
      const bottom =
        i + 1 < coreLevels.length
          ? roofZ(coreLevels[i + 1])
          : roofZ(bodyTopElevationM);
      const top = roofZ(coreLevels[i]);
      if (!shape.isEmpty() && top > bottom) bands.push({ shape, bottom, top });
    }
    // Higher core masks are nested inside the next lower mask. A one-micron
    // overlap is therefore already occupied material; it keeps adjacent native
    // extrusions from meeting through an unstable zero-thickness interface.
    const main = arena.keep(
      cad.Manifold.union(
        bands.map(({ shape, bottom, top }) => {
          const overlap = bottom > 0 ? 0.000001 : 0;
          return arena.keep(
            arena
              .keep(shape.extrude(top - bottom + overlap))
              .translate([0, 0, bottom - overlap]),
          );
        }),
      ),
    );
    if (main.status() !== "NoError" || main.isEmpty()) return null;
    const solids: Manifold[] = [main];
    const heights = observed.levels
      .map((level) => level.elevationM)
      .sort((a, b) => a - b);
    const minimumGap = Math.min(
      ...heights.slice(1).map((value, i) => value - heights[i]),
    );
    const slabThicknessMm = Math.min(
      0.3,
      Math.max(0.24, options.minFeatureMm * 0.6),
      minimumGap * sf * buildingScale * 0.45,
    );
    // Do not merge every floor to rescue a model below printable resolution.
    if (!Number.isFinite(slabThicknessMm) || slabThicknessMm < 0.12)
      return null;
    let retainedLevelCount = 0,
      terraceCount = 0,
      inferredConnectionCount = 0,
      omittedFragmentCount = 0;
    const coreRings = core.toPolygons();
    const maximumGap = observed.method.coreConnectionMaxM * sf;
    const addPlate = (shape: CrossSection, elevation: number) => {
      const z = roofZ(elevation);
      if (z <= slabThicknessMm || !Number.isFinite(z)) return false;
      let retained = false;
      for (const part of shape.decompose().map((item) => arena.keep(item))) {
        if (part.area() < Math.max(0.0025, options.minFeatureMm ** 2 / 16)) {
          omittedFragmentCount++;
          continue;
        }
        let connected = part;
        let inferred = false;
        const overlap = arena.keep(part.intersect(core));
        if (overlap.area() <= 0.000001) {
          const pair = nearestPair(part.toPolygons(), coreRings);
          if (pair.distance > maximumGap + 0.000001) {
            omittedFragmentCount++;
            continue;
          }
          const length = Math.max(pair.distance, 0.000001);
          const ux = (pair.to[0] - pair.from[0]) / length,
            uy = (pair.to[1] - pair.from[1]) / length;
          const halfWidth = Math.min(
            options.minFeatureMm / 2,
            Math.sqrt(part.area()) / 2,
          );
          const reach = Math.max(0.005, halfWidth);
          // A short horizontal tongue joins an occluded edge to the mapped
          // facade. It is bounded by the municipal envelope and never reaches
          // the ground as a fictitious supporting column.
          const a: Point2D = [
            pair.from[0] - ux * reach,
            pair.from[1] - uy * reach,
          ];
          const b: Point2D = [pair.to[0] + ux * reach, pair.to[1] + uy * reach];
          const connector = arena.keep(
            arena
              .keep(
                new cad.CrossSection(
                  [
                    [
                      [a[0] - uy * halfWidth, a[1] + ux * halfWidth],
                      [b[0] - uy * halfWidth, b[1] + ux * halfWidth],
                      [b[0] + uy * halfWidth, b[1] - ux * halfWidth],
                      [a[0] + uy * halfWidth, a[1] - ux * halfWidth],
                    ],
                  ],
                  "EvenOdd",
                ),
              )
              .intersect(footprint),
          );
          connected = arena.keep(part.add(connector));
          if (arena.keep(connected.intersect(core)).area() <= 0.000001) {
            omittedFragmentCount++;
            continue;
          }
          inferred = true;
        }
        const plate = arena.keep(
          arena
            .keep(connected.extrude(slabThicknessMm))
            .translate([0, 0, z - slabThicknessMm]),
        );
        // A top-storey slab can overlap the core in plan while sitting above
        // its local roof. Such an orphan is not rescued with an invented post.
        const attached = arena.keep(plate.intersect(main));
        if (attached.isEmpty() || attached.volume() <= 0.000001) {
          omittedFragmentCount++;
          continue;
        }
        solids.push(plate);
        if (inferred) inferredConnectionCount++;
        terraceCount++;
        retained = true;
      }
      return retained;
    };
    for (const level of observed.levels) {
      const shapes = level.polygons.map((polygon) => section(polygon));
      if (!shapes.length) continue;
      const shape = arena.keep(
        arena.keep(cad.CrossSection.union(shapes)).intersect(footprint),
      );
      if (addPlate(shape, level.elevationM)) retainedLevelCount++;
    }
    // The 2020 roof panels describe the core's height field. Outside the core,
    // use only the more recent observed 2021 levels: superimposing the two
    // epochs would create duplicate, slightly displaced terrace slabs.
    const native = arena.keep(
      arena.keep(cad.Manifold.union(solids)).translate(origin),
    );
    if (native.status() !== "NoError" || native.isEmpty()) return null;
    const originalVolume = native.volume();
    const nativeMesh = native.getMesh();
    const rounded = arena.keep(
      new cad.Manifold(contractShortEdges(cad, nativeMesh, 0.0001, true)),
    );
    const simplified = arena.keep(
      rounded.simplify(Math.min(0.0001, nativeMesh.tolerance)),
    );
    const clean = (solid: Manifold) =>
      removeNumericalShells(
        cad,
        arena,
        arena.keep(
          new cad.Manifold(
            repairCollinear(
              cad,
              repairNumericalTriangles(
                cad,
                repairCoincident(cad, solid.getMesh()),
              ),
            ),
          ),
        ),
        (part) => Math.abs(part.volume()) > 0.000001,
      );
    let cleaned = clean(simplified);
    let repairedContactCount = 0;
    for (let pass = 0; pass < 3 && !closedBoundary(cleaned.getMesh()); pass++) {
      const repair = openEdgeContacts(cad, arena, cleaned, 0.005, {
        lineContactSegments: 4,
        shortContactShape: pass > 0 ? "line" : "faces",
      });
      repairedContactCount += repair.repairedCount;
      cleaned = clean(repair.solid);
    }
    // Use the existing per-survey precision budget, including the complete
    // Float32 reconstruction, rather than resetting it after each local cut.
    if (
      !closedBoundary(cleaned.getMesh()) ||
      Math.abs(cleaned.volume() - originalVolume) >
        originalVolume * 0.0001 + 3 * Math.max(0.000001, originalVolume * 1e-8)
    )
      return null;
    const components = cleaned.decompose().map((part) => arena.keep(part));
    if (
      components.length !== 1 ||
      components[0].boundingBox().min[2] > foundationZ + 0.0001
    )
      return null;
    // Validate and clean in the final plate coordinates: translating a clean
    // local Float32 mesh afterwards can expose another rounding contact.
    output = owner.keep(cleaned.translate([0, 0, 0]));
    return {
      solid: output,
      observedLevelCount: observed.levels.length,
      retainedLevelCount,
      terraceCount,
      inferredConnectionCount,
      omittedFragmentCount,
      slabThicknessMm,
      repairedContactCount,
      repairVolumeDeltaMm3: cleaned.volume() - originalVolume,
      bodyTopElevationM,
      estimatedBody: true,
    };
  } catch {
    return null;
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
}
