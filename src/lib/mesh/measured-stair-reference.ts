import earcut from "earcut";
import type { Point2D, Polygon2D } from "@/types/geometry";
import type { BuildingData, RoadData } from "../osm/parse-elements";
import { pointInPolygon } from "../polygon/point-in-polygon";

interface Vertex {
  point: Point2D;
  elevation: number;
}

interface Floor {
  polygon: Polygon2D;
  vertices: Vertex[];
  triangles: number[];
}

export interface StairLandingReference {
  kind: "measured" | "terrain" | "snapped";
  sourceElevationM: number | null;
  printElevationMm: number;
  /** Snapping is opt-in and retains its distance and exact source boundary point. */
  snap?: { distanceM: number; point: Point2D };
}

export interface MeasuredStairReference {
  surfaceAt: (x: number, y: number) => number;
  sourceElevationAt: (x: number, y: number) => number | null;
  start: StairLandingReference;
  end: StairLandingReference;
  measuredDeltaMm: number;
  /** Exact surveyed floor masks, including holes, in the same mm frame as the road. */
  walkablePolygons: Polygon2D[];
  /** Let the caller preserve other architecture outside the surveyed walking surfaces. */
  buildingFootprint: Polygon2D;
  sourceId: string;
  source: string;
  year: number;
}

export interface MeasuredStairReferenceOptions {
  scaleFactor: number;
  fallbackSurfaceAt: (x: number, y: number) => number;
  /** Distance from the mapped endpoint to the source boundary; disabled by default. */
  maxSnapM?: number;
}

function cross(a: Point2D, b: Point2D, p: Point2D) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function interpolate(floors: Floor[], point: Point2D): number | null {
  for (const floor of floors) {
    for (let i = 0; i < floor.triangles.length; i += 3) {
      const a = floor.vertices[floor.triangles[i]],
        b = floor.vertices[floor.triangles[i + 1]],
        c = floor.vertices[floor.triangles[i + 2]];
      const denominator = cross(a.point, b.point, c.point);
      if (Math.abs(denominator) < 1e-12) continue;
      const u = cross(point, b.point, c.point) / denominator,
        v = cross(a.point, point, c.point) / denominator,
        w = 1 - u - v;
      if (u >= -1e-7 && v >= -1e-7 && w >= -1e-7)
        return u * a.elevation + v * b.elevation + w * c.elevation;
    }
  }
  return null;
}

function nearestBoundary(floors: Floor[], point: Point2D) {
  let best: { distance: number; point: Point2D; elevation: number } | null = null;
  for (const floor of floors) {
    // A hole represents absent walking surface; do not invent a landing inside it.
    if (floor.polygon.holes.some((hole) => pointInPolygon(...point, hole))) continue;
    const outer = floor.polygon.outer;
    for (let i = 0; i < outer.length; i++) {
      const a = floor.vertices[i], b = floor.vertices[(i + 1) % outer.length];
      const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
      const length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const t = Math.max(0, Math.min(1,
        ((point[0] - a.point[0]) * dx + (point[1] - a.point[1]) * dy) / length2,
      ));
      const projected: Point2D = [a.point[0] + t * dx, a.point[1] + t * dy];
      const distance = Math.hypot(projected[0] - point[0], projected[1] - point[1]);
      if (!best || distance < best.distance)
        best = { distance, point: projected, elevation: a.elevation + t * (b.elevation - a.elevation) };
    }
  }
  return best;
}

function direction(tags: Record<string, string>): number | null {
  const value = tags.incline?.trim().toLowerCase();
  if (value === "up") return 1;
  if (value === "down") return -1;
  if (value && /^[+-]?\d+(?:[.,]\d+)?\s*(?:%|°|deg)?$/.test(value)) {
    const number = Number.parseFloat(value.replace(",", "."));
    if (number) return Math.sign(number);
  }
  return null;
}

/**
 * Associate a mapped stair with exposed measured floor surfaces, never roof or wall
 * projections. Uncovered landings keep their terrain height. The elevation callback
 * owns the source datum/vertical placement, so no maximum-DEM translation is assumed.
 */
export function buildMeasuredStairReference(
  road: RoadData,
  buildings: BuildingData[],
  projectMm: (lon: number, lat: number) => Point2D,
  toPrintElevation: (building: BuildingData, elevationM: number) => number,
  options: MeasuredStairReferenceOptions,
): MeasuredStairReference | null {
  if (road.roadType !== "steps" || road.polyline.length < 2 ||
    !road.polyline.every((point) => point.every(Number.isFinite)) ||
    !Number.isFinite(options.scaleFactor) || options.scaleFactor <= 0) return null;
  const maxSnapM = options.maxSnapM ?? 0;
  if (!Number.isFinite(maxSnapM) || maxSnapM < 0 || maxSnapM > 10) return null;
  const first = road.polyline[0], last = road.polyline.at(-1)!;
  const margin = Math.max(road.halfWidth, 0) + maxSnapM * options.scaleFactor;
  const minX = Math.min(...road.polyline.map((point) => point[0])) - margin,
    maxX = Math.max(...road.polyline.map((point) => point[0])) + margin,
    minY = Math.min(...road.polyline.map((point) => point[1])) - margin,
    maxY = Math.max(...road.polyline.map((point) => point[1])) + margin;
  const candidates: Array<{ reference: MeasuredStairReference; measured: number; nearby: number }> = [];
  for (const building of buildings) {
    const solid = building.measuredSolid;
    if (!solid) continue;
    const floors: Floor[] = [];
    for (const surface of solid.surfaces) {
      if (surface.kind !== "outerFloor") continue;
      const vertices: Vertex[] = [], holes: number[] = [], rings: Point2D[][] = [];
      let valid = true;
      for (const [index, raw] of [surface.outer, ...surface.holes].entries()) {
        if (index) holes.push(vertices.length);
        const ring: Point2D[] = [];
        for (const vertex of raw) {
          const point = projectMm(vertex.lon, vertex.lat);
          if (!point.every(Number.isFinite) || !Number.isFinite(vertex.elevation)) valid = false;
          vertices.push({point, elevation: vertex.elevation});
          ring.push(point);
        }
        rings.push(ring);
      }
      if (!valid || rings[0].length < 3) continue;
      const outer = rings[0];
      if (Math.max(...outer.map((point) => point[0])) < minX ||
        Math.min(...outer.map((point) => point[0])) > maxX ||
        Math.max(...outer.map((point) => point[1])) < minY ||
        Math.min(...outer.map((point) => point[1])) > maxY) continue;
      const triangles = earcut(vertices.flatMap((vertex) => vertex.point), holes);
      if (triangles.length) floors.push({polygon: {outer, holes: rings.slice(1)}, vertices, triangles});
    }
    if (!floors.length) continue;
    const sourceElevationAt = (x: number, y: number) => interpolate(floors, [x, y]);
    const landing = (point: Point2D): StairLandingReference => {
      const elevation = interpolate(floors, point);
      if (elevation != null)
        return {kind: "measured", sourceElevationM: elevation, printElevationMm: toPrintElevation(building, elevation)};
      if (maxSnapM) {
        const nearest = nearestBoundary(floors, point);
        if (nearest && nearest.distance <= maxSnapM * options.scaleFactor)
          return {kind: "snapped", sourceElevationM: nearest.elevation,
            printElevationMm: toPrintElevation(building, nearest.elevation),
            snap: {distanceM: nearest.distance / options.scaleFactor, point: nearest.point}};
      }
      return {kind: "terrain", sourceElevationM: null, printElevationMm: options.fallbackSurfaceAt(...point)};
    };
    const start = landing(first), end = landing(last);
    const measured = Number(start.kind !== "terrain") + Number(end.kind !== "terrain");
    const delta = end.printElevationMm - start.printElevationMm, expected = direction(road.tags);
    if (!measured || ![start.printElevationMm, end.printElevationMm].every(Number.isFinite) ||
      Math.abs(delta) <= .02 || (expected != null && Math.sign(delta) !== expected)) continue;
    const surfaceAt = (x: number, y: number) => {
      if (Math.hypot(x - first[0], y - first[1]) < 1e-7) return start.printElevationMm;
      if (Math.hypot(x - last[0], y - last[1]) < 1e-7) return end.printElevationMm;
      const elevation = sourceElevationAt(x, y);
      return elevation == null ? options.fallbackSurfaceAt(x, y) : toPrintElevation(building, elevation);
    };
    const nearby = road.polyline.filter((point) => interpolate(floors, point) != null).length;
    candidates.push({measured, nearby, reference: {surfaceAt, sourceElevationAt, start, end,
      measuredDeltaMm: delta, walkablePolygons: floors.map((floor) => floor.polygon),
      buildingFootprint: building.polygon, sourceId: building.tags["printmap:source_id"] ?? building.sourceId ?? "",
      source: solid.source, year: solid.year}});
  }
  return candidates.sort((a, b) => b.measured - a.measured || b.nearby - a.nearby)[0]?.reference ?? null;
}
