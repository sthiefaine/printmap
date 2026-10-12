import earcut from "earcut";
import type { BBox, OverpassElement, RoofSurface } from "@/types/osm";
import { elementPolygons } from "@/lib/osm/relation-polygons";
import { fromLambert93, toLambert93 } from "./lambert93";
import { fetchWithTimeout } from "./request";
import { MAX_ROOF_BUILDINGS, MAX_ROOF_VERTICES } from "./validate-roofs";

/** This is a reconstructed 2.5D roof, not a surveyed CityGML facade/solid. */
export const IGN_ROOF_SOURCE =
  "IGN LiDAR HD · toiture reconstruite depuis le MNS et le MNT, Licence Ouverte 2.0 · https://www.data.gouv.fr/datasets/mnh-lidar-hd";
const MAX_PIXELS = 4_000_000;
const MAX_DIMENSION = 4096;
const TILE_SIZE = 1024;
const MAX_BUILDINGS = 2000;
const MAX_SURFACES = 60_000;
const MAX_BUILDING_SURFACES = 512;

type Point = [number, number];
type Bounds = [number, number, number, number];
interface Sample {
  x: number;
  y: number;
  z: number;
  ground: number;
}
interface Plane {
  a: number;
  b: number;
  c: number;
}

export interface IGNRoofGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  /** Pixel spacing in Lambert-93 metres; native source spacing is 0.5 m. */
  resolutionM: number;
  mns: Float32Array;
  mnt: Float32Array;
}

export interface IGNRoofEnrichment {
  elements: OverpassElement[];
  buildingCount: number;
  surfaceCount: number;
  triangleCount: number;
  resolutionM: number | null;
  warnings: string[];
  sources: string[];
}

// One completed grid, at most 32 MB of raster values. No unbounded region cache.
let cache: { key: string; grid: IGNRoofGrid; expires: number } | undefined;

export function planIGNRoofGrid(bbox: BBox): Omit<IGNRoofGrid, "mns" | "mnt"> {
  const [south, west, north, east] = bbox;
  if (
    !bbox.every(Number.isFinite) ||
    south >= north ||
    west >= east ||
    south < 41 ||
    north > 52 ||
    west < -6 ||
    east > 10
  )
    throw new Error("Emprise IGN invalide");
  const corners = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ].map(([lon, lat]) => toLambert93(lon, lat));
  const x0 = Math.min(...corners.map((p) => p[0]));
  const x1 = Math.max(...corners.map((p) => p[0]));
  const y0 = Math.min(...corners.map((p) => p[1]));
  const y1 = Math.max(...corners.map((p) => p[1]));
  // Adaptive spacing stays on a multiple of the native 50 cm grid.
  let resolutionM = Math.max(
    0.5,
    Math.ceil(
      Math.max(
        Math.sqrt(((x1 - x0) * (y1 - y0)) / (MAX_PIXELS - 20000)),
        (x1 - x0) / (MAX_DIMENSION - 2),
        (y1 - y0) / (MAX_DIMENSION - 2),
      ) * 2,
    ) / 2,
  );
  for (;;) {
    const w = Math.floor(x0 / resolutionM) * resolutionM - resolutionM / 2;
    const s = Math.floor(y0 / resolutionM) * resolutionM - resolutionM / 2;
    const cols = Math.ceil((x1 - w) / resolutionM) + 1;
    const rows = Math.ceil((y1 - s) / resolutionM) + 1;
    if (
      cols * rows <= MAX_PIXELS &&
      cols <= MAX_DIMENSION &&
      rows <= MAX_DIMENSION
    )
      return {
        west: w,
        south: s,
        east: w + cols * resolutionM,
        north: s + rows * resolutionM,
        cols,
        rows,
        resolutionM,
      };
    resolutionM += 0.5;
  }
}

async function readBIL(response: Response, expectedBytes: number) {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("image/x-bil")
  )
    throw new Error("Raster IGN indisponible");
  const declared = Number(response.headers.get("content-length"));
  if (declared > expectedBytes) throw new Error("Raster IGN trop volumineux");
  if (!response.body) throw new Error("Raster IGN vide");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes)
        throw new Error("Raster IGN trop volumineux");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedBytes) throw new Error("Raster IGN tronqué");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const data = new Float32Array(expectedBytes / 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, true);
  return data;
}

export async function fetchIGNRoofGrid(
  bbox: BBox,
  signal: AbortSignal,
): Promise<IGNRoofGrid> {
  signal.throwIfAborted();
  const plan = planIGNRoofGrid(bbox);
  const key = JSON.stringify(plan);
  if (cache?.key === key && cache.expires > Date.now()) return cache.grid;
  const internal = new AbortController();
  const deadline = AbortSignal.any([
    signal,
    internal.signal,
    AbortSignal.timeout(25000),
  ]);
  const grid: IGNRoofGrid = {
    ...plan,
    mns: new Float32Array(plan.cols * plan.rows),
    mnt: new Float32Array(plan.cols * plan.rows),
  };
  const jobs: Array<{
    col: number;
    row: number;
    width: number;
    height: number;
    kind: "MNS" | "MNT";
  }> = [];
  for (let row = 0; row < plan.rows; row += TILE_SIZE)
    for (let col = 0; col < plan.cols; col += TILE_SIZE)
      for (const kind of ["MNS", "MNT"] as const)
        jobs.push({
          row,
          col,
          width: Math.min(TILE_SIZE, plan.cols - col),
          height: Math.min(TILE_SIZE, plan.rows - row),
          kind,
        });
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      deadline.throwIfAborted();
      const job = jobs[cursor++];
      const west = plan.west + job.col * plan.resolutionM;
      const north = plan.north - job.row * plan.resolutionM;
      const url = new URL("https://data.geopf.fr/wms-r/wms");
      for (const [name, value] of Object.entries({
        SERVICE: "WMS",
        VERSION: "1.3.0",
        REQUEST: "GetMap",
        STYLES: "",
        CRS: "EPSG:2154",
        LAYERS: `IGNF_LIDAR-HD_${job.kind}_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93`,
        BBOX: `${west},${north - job.height * plan.resolutionM},${west + job.width * plan.resolutionM},${north}`,
        WIDTH: String(job.width),
        HEIGHT: String(job.height),
        FORMAT: "image/x-bil;bits=32",
      }))
        url.searchParams.set(name, value);
      const response = await fetchWithTimeout(
        url.toString(),
        { cache: "no-store" },
        deadline,
        12000,
      );
      const tile = await readBIL(response, job.width * job.height * 4);
      deadline.throwIfAborted();
      const target = job.kind === "MNS" ? grid.mns : grid.mnt;
      for (let y = 0; y < job.height; y++)
        target.set(
          tile.subarray(y * job.width, (y + 1) * job.width),
          (job.row + y) * plan.cols + job.col,
        );
    }
  }
  // At most four requests and four bounded tile buffers at once.
  const workers = Array.from({ length: Math.min(4, jobs.length) }, worker);
  try {
    await Promise.all(workers);
  } catch (error) {
    internal.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
  signal.throwIfAborted();
  cache = { key, grid, expires: Date.now() + 30 * 60 * 1000 };
  return grid;
}

function pointInRing(x: number, y: number, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if (
      ring[i][1] > y !== ring[j][1] > y &&
      x <
        ((ring[j][0] - ring[i][0]) * (y - ring[i][1])) /
          (ring[j][1] - ring[i][1]) +
          ring[i][0]
    )
      inside = !inside;
  return inside;
}
function insidePolygon(x: number, y: number, rings: Point[][]) {
  return (
    pointInRing(x, y, rings[0]) &&
    !rings.slice(1).some((ring) => pointInRing(x, y, ring))
  );
}
function boundaryDistance(x: number, y: number, rings: Point[][]) {
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1),
        ),
      );
      best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
    }
  return best;
}
function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
function planeAt(p: Plane, x: number, y: number) {
  return p.a * x + p.b * y + p.c;
}
function fitPlane(samples: Sample[]): Plane | null {
  if (samples.length < 6) return null;
  let mx = 0,
    my = 0,
    mz = 0;
  for (const p of samples) {
    mx += p.x;
    my += p.y;
    mz += p.z;
  }
  mx /= samples.length;
  my /= samples.length;
  mz /= samples.length;
  let xx = 0,
    xy = 0,
    yy = 0,
    xz = 0,
    yz = 0;
  for (const p of samples) {
    const x = p.x - mx,
      y = p.y - my,
      z = p.z - mz;
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xz += x * z;
    yz += y * z;
  }
  const determinant = xx * yy - xy * xy;
  if (determinant < 1e-8) return null;
  const a = (xz * yy - yz * xy) / determinant;
  const b = (yz * xx - xz * xy) / determinant;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) > 2.75)
    return null;
  return { a, b, c: mz - a * mx - b * my };
}
function area(poly: Point[]) {
  let value = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    value += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(value) / 2;
}
function clipBounds(poly: Point[], bounds: Bounds) {
  let result = poly;
  for (const [axis, value, direction] of [
    [0, bounds[0], 1],
    [0, bounds[2], -1],
    [1, bounds[1], 1],
    [1, bounds[3], -1],
  ]) {
    if (!result.length) break;
    const next: Point[] = [];
    let before = result.at(-1)!;
    let beforeSide = (before[axis] - value) * direction;
    for (const current of result) {
      const side = (current[axis] - value) * direction;
      if (side >= 0 !== beforeSide >= 0) {
        const t = beforeSide / (beforeSide - side);
        next.push([
          before[0] + (current[0] - before[0]) * t,
          before[1] + (current[1] - before[1]) * t,
        ]);
      }
      if (side >= 0) next.push(current);
      before = current;
      beforeSide = side;
    }
    result = next;
  }
  return result;
}

/** Remove internal clipping/earcut diagonals within ONE fitted leaf. Coordinates
 * are retained; a key only identifies roundoff-equivalent intersection points. */
function mergeLeafPieces(
  pieces: Point[][],
): Array<{ outer: Point[]; holes: Point[][] }> | null {
  if (!pieces.length) return [];
  const key = ([x, y]: Point) => `${x.toFixed(8)},${y.toFixed(8)}`;
  const points = new Map<string, Point>();
  const edges = new Map<string, { from: string; to: string }>();
  function signed(ring: Point[]) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return sum / 2;
  }
  const orientation = Math.sign(signed(pieces[0]));
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) {
      const a = piece[i],
        b = piece[(i + 1) % piece.length];
      const from = key(a),
        to = key(b);
      if (from === to) continue;
      if (!points.has(from)) points.set(from, a);
      if (!points.has(to)) points.set(to, b);
      const forward = `${from}>${to}`,
        reverse = `${to}>${from}`;
      if (edges.has(reverse)) edges.delete(reverse);
      else if (edges.has(forward)) return null;
      else edges.set(forward, { from, to });
    }
  }
  const outgoing = new Map<string, Array<{ from: string; to: string }>>();
  for (const edge of edges.values()) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const pending = new Set(edges.keys());
  const rings: Point[][] = [];
  while (pending.size) {
    const first = edges.get(pending.values().next().value!)!;
    const ring: Point[] = [];
    let edge = first;
    for (let guard = 0; guard <= edges.size; guard++) {
      const id = `${edge.from}>${edge.to}`;
      if (!pending.delete(id)) return null;
      ring.push(points.get(edge.from)!);
      if (edge.to === first.from) break;
      const choices = (outgoing.get(edge.to) ?? []).filter((e) =>
        pending.has(`${e.from}>${e.to}`),
      );
      if (!choices.length) return null;
      const a = points.get(edge.from)!,
        b = points.get(edge.to)!;
      choices.sort((left, right) => {
        const turn = (candidate: { to: string }) => {
          const c = points.get(candidate.to)!;
          return Math.atan2(
            (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
            (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]),
          );
        };
        return orientation * (turn(right) - turn(left));
      });
      edge = choices[0];
      if (guard === edges.size) return null;
    }
    // Remove exact collinear cuts on horizontal/vertical clipping boundaries.
    // Original footprint corners and non-axis-aligned coordinates are retained.
    let changed = true;
    while (changed && ring.length > 3) {
      changed = false;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[(i + ring.length - 1) % ring.length],
          b = ring[i],
          c = ring[(i + 1) % ring.length];
        if (
          (a[0] === b[0] && b[0] === c[0]) ||
          (a[1] === b[1] && b[1] === c[1])
        ) {
          ring.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    if (ring.length < 3 || area(ring) < 1e-7) return null;
    rings.push(ring);
  }
  rings.sort((a, b) => area(b) - area(a));
  if (!rings.length) return null;
  const outerSign = Math.sign(signed(rings[0]));
  const outers = rings.filter((ring) => Math.sign(signed(ring)) === outerSign);
  const holes = rings.filter((ring) => Math.sign(signed(ring)) !== outerSign);
  const polygons = outers.map((outer) => ({ outer, holes: [] as Point[][] }));
  for (const hole of holes) {
    const parent = polygons
      .filter((p) => pointInRing(hole[0][0], hole[0][1], p.outer))
      .sort((a, b) => area(a.outer) - area(b.outer))[0];
    if (!parent) return null;
    parent.holes.push(hole);
  }
  return polygons;
}

/** Optional builder-only conformity for RECONSTRUCTED LiDAR pans. Primary
 * CityGML/CityJSON geometry must never use this adjustment. Split every native
 * Lambert-93 T-junction, then join only elevation clusters whose entire range is
 * within the reconstruction fit threshold (not the measurement accuracy).
 * Genuine height steps keep distinct elevations at the same XY position. */
export function conformIGNRoofSurfaces(
  surfaces: RoofSurface[],
  toleranceM: number,
): RoofSurface[] | null {
  if (
    !surfaces.length ||
    surfaces.length > 512 ||
    !Number.isFinite(toleranceM) ||
    toleranceM < 0 ||
    toleranceM > 10
  )
    return null;
  const xyTolerance = 0.001;
  type Node = { x: number; y: number; lat: number; lon: number };
  type Occurrence = { node: number; z: number };
  const nodes: Node[] = [];
  const buckets = new Map<string, number[]>();
  const rings: Occurrence[][][] = [];
  let inputVertices = 0;
  const first = surfaces[0]?.outer?.[0];
  if (!first || ![first.lon, first.lat].every(Number.isFinite)) return null;
  const [originX, originY] = toLambert93(first.lon, first.lat);
  function canonical(point: RoofSurface["outer"][number]): number | null {
    if (
      !point ||
      ![point.lon, point.lat, point.elevation].every(Number.isFinite) ||
      Math.abs(point.lon) > 180 ||
      Math.abs(point.lat) > 85 ||
      point.elevation < -100 ||
      point.elevation > 1000
    )
      return null;
    const native = toLambert93(point.lon, point.lat);
    const x = native[0] - originX,
      y = native[1] - originY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cx = Math.floor(x / xyTolerance),
      cy = Math.floor(y / xyTolerance);
    let match: number | undefined,
      distance = xyTolerance;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = Math.hypot(nodes[id].x - x, nodes[id].y - y);
          if (d <= distance) {
            match = id;
            distance = d;
          }
        }
      }
    if (match != null) return match;
    const id = nodes.length;
    nodes.push({ x, y, lon: point.lon, lat: point.lat });
    const key = `${cx},${cy}`,
      list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
    return id;
  }
  for (const surface of surfaces) {
    if (
      !surface ||
      !Array.isArray(surface.outer) ||
      !Array.isArray(surface.holes)
    )
      return null;
    const surfaceRings: Occurrence[][] = [];
    for (const ring of [surface.outer, ...surface.holes]) {
      if (
        !Array.isArray(ring) ||
        ring.length < 4 ||
        (inputVertices += ring.length) > 4096
      )
        return null;
      const occurrences: Occurrence[] = [];
      for (const point of ring) {
        const node = canonical(point);
        if (node == null) return null;
        occurrences.push({ node, z: point.elevation });
      }
      if (
        occurrences[0].node !== occurrences.at(-1)!.node ||
        Math.abs(occurrences[0].z - occurrences.at(-1)!.z) > 0.01
      )
        return null;
      occurrences.pop();
      if (
        occurrences.some(
          (p, i) => p.node === occurrences[(i + 1) % occurrences.length].node,
        )
      )
        return null;
      surfaceRings.push(occurrences);
    }
    rings.push(surfaceRings);
  }
  // Coarse buckets avoid testing every roof vertex against every small edge.
  const span =
    Math.max(...nodes.map((n) => n.x)) -
    Math.min(...nodes.map((n) => n.x)) +
    Math.max(...nodes.map((n) => n.y)) -
    Math.min(...nodes.map((n) => n.y));
  const cellSize = Math.max(1, span / 24);
  const index = new Map<string, number[]>();
  for (const [id, node] of nodes.entries()) {
    const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
    const list = index.get(key) ?? [];
    list.push(id);
    index.set(key, list);
  }
  const expanded: Occurrence[][][] = [];
  let outputVertices = 0,
    checks = 0;
  for (const surfaceRings of rings) {
    const nextRings: Occurrence[][] = [];
    for (const ring of surfaceRings) {
      const next: Occurrence[] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        const from = nodes[a.node],
          to = nodes[b.node];
        const dx = to.x - from.x,
          dy = to.y - from.y,
          length2 = dx * dx + dy * dy;
        const splits: Array<{ node: number; t: number }> = [];
        const x0 = Math.floor(
          (Math.min(from.x, to.x) - xyTolerance) / cellSize,
        );
        const x1 = Math.floor(
          (Math.max(from.x, to.x) + xyTolerance) / cellSize,
        );
        const y0 = Math.floor(
          (Math.min(from.y, to.y) - xyTolerance) / cellSize,
        );
        const y1 = Math.floor(
          (Math.max(from.y, to.y) + xyTolerance) / cellSize,
        );
        for (let cx = x0; cx <= x1; cx++)
          for (let cy = y0; cy <= y1; cy++) {
            for (const id of index.get(`${cx},${cy}`) ?? []) {
              if (++checks > 2_000_000) return null;
              if (id === a.node || id === b.node) continue;
              const point = nodes[id];
              const t =
                ((point.x - from.x) * dx + (point.y - from.y) * dy) / length2;
              if (
                t <= 0 ||
                t >= 1 ||
                Math.hypot(
                  point.x - from.x - t * dx,
                  point.y - from.y - t * dy,
                ) > xyTolerance
              )
                continue;
              splits.push({ node: id, t });
            }
          }
        splits.sort((left, right) => left.t - right.t);
        next.push({ ...a });
        for (const split of splits)
          next.push({ node: split.node, z: a.z + (b.z - a.z) * split.t });
        outputVertices += 1 + splits.length;
        if (outputVertices > 16384) return null;
      }
      nextRings.push(next);
    }
    expanded.push(nextRings);
  }
  const elevations = new Map<number, Occurrence[]>();
  for (const surface of expanded)
    for (const ring of surface)
      for (const point of ring) {
        const list = elevations.get(point.node) ?? [];
        list.push(point);
        elevations.set(point.node, list);
      }
  for (const list of elevations.values()) {
    list.sort((a, b) => a.z - b.z);
    for (let start = 0; start < list.length;) {
      let end = start + 1;
      while (end < list.length && list[end].z - list[start].z <= toleranceM)
        end++;
      const mean =
        list.slice(start, end).reduce((sum, p) => sum + p.z, 0) / (end - start);
      for (let i = start; i < end; i++) list[i].z = mean;
      start = end;
    }
  }
  return expanded.map((surface) => {
    const converted = surface.map((ring) => {
      const points = ring.map(({ node, z }) => ({
        lat: nodes[node].lat,
        lon: nodes[node].lon,
        elevation: z,
      }));
      points.push({ ...points[0] });
      return points;
    });
    return { outer: converted[0], holes: converted.slice(1) };
  });
}

/** Reconstruct local planes only where the measured surface supports them.
 * Rectangular subdivisions are clipped to a triangulation of the exact footprint,
 * including holes. No roof shape, symmetry, ridge or facade is invented. */
export function reconstructIGNRoof(
  element: OverpassElement,
  grid: IGNRoofGrid,
  ways?: Map<number, OverpassElement>,
  continueWork: () => boolean = () => true,
): {
  surfaces: RoofSurface[];
  groundElevation: number;
  maxElevation: number;
  triangleCount: number;
} | null {
  if (!continueWork()) return null;
  const polygons = elementPolygons(element, ways);
  if (!polygons.length || polygons.length > 8) return null;
  const origin: Point = [grid.west, grid.south];
  const surfaces: RoofSurface[] = [];
  const allGround: number[] = [];
  let maxElevation = -Infinity,
    triangleCount = 0;
  for (const polygon of polygons) {
    if (!continueWork()) return null;
    const rings = [polygon.outer, ...polygon.holes].map((ring) =>
      ring.slice(0, -1).map((p): Point => {
        const [x, y] = toLambert93(p.lon, p.lat);
        return [x - origin[0], y - origin[1]];
      }),
    );
    if (rings[0].length < 3 || rings.flat().length > 256) return null;
    const points = rings.flat();
    const holes: number[] = [];
    let cursor = rings[0].length;
    for (const ring of rings.slice(1)) {
      holes.push(cursor);
      cursor += ring.length;
    }
    const indices = earcut(points.flat(), holes);
    const triangles: Point[][] = [];
    for (let i = 0; i < indices.length; i += 3)
      triangles.push([
        points[indices[i]],
        points[indices[i + 1]],
        points[indices[i + 2]],
      ]);
    const bounds: Bounds = [
      Math.min(...rings[0].map((p) => p[0])),
      Math.min(...rings[0].map((p) => p[1])),
      Math.max(...rings[0].map((p) => p[0])),
      Math.max(...rings[0].map((p) => p[1])),
    ];
    const res = grid.resolutionM;
    if (
      bounds[0] < -2 * res ||
      bounds[1] < -2 * res ||
      bounds[2] > grid.east - origin[0] + 2 * res ||
      bounds[3] > grid.north - origin[1] + 2 * res
    )
      return null;
    const col0 = Math.max(0, Math.floor(bounds[0] / res));
    const col1 = Math.min(grid.cols - 1, Math.floor(bounds[2] / res));
    const row0 = Math.max(
      0,
      Math.floor((grid.north - origin[1] - bounds[3]) / res),
    );
    const row1 = Math.min(
      grid.rows - 1,
      Math.floor((grid.north - origin[1] - bounds[1]) / res),
    );
    if ((col1 - col0 + 1) * (row1 - row0 + 1) > 120000) return null;
    const samples: Sample[] = [];
    let interior = 0,
      invalid = 0;
    let rough = 0;
    for (let row = row0; row <= row1; row++) {
      if (!continueWork()) return null;
      for (let col = col0; col <= col1; col++) {
        if ((col - col0) % 32 === 0 && !continueWork()) return null;
        const x = (col + 0.5) * res;
        const y = grid.north - origin[1] - (row + 0.5) * res;
        if (
          !insidePolygon(x, y, rings) ||
          boundaryDistance(x, y, rings) < Math.min(1.5, res * 0.65)
        )
          continue;
        interior++;
        const index = row * grid.cols + col,
          ground = grid.mnt[index],
          raw = grid.mns[index];
        if (
          !Number.isFinite(raw) ||
          !Number.isFinite(ground) ||
          ground < -100 ||
          ground > 1000 ||
          raw < -100 ||
          raw > 1000 ||
          raw - ground < 2 ||
          raw - ground > 200
        ) {
          invalid++;
          continue;
        }
        // A median removes isolated antennas/noise, while coherent curved roofs remain.
        const neighbours: number[] = [];
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = row + dr,
              cc = col + dc;
            if (rr < 0 || cc < 0 || rr >= grid.rows || cc >= grid.cols)
              continue;
            const value = grid.mns[rr * grid.cols + cc];
            if (
              Number.isFinite(value) &&
              value >= -100 &&
              value <= 1000 &&
              value - ground >= 2 &&
              value - ground <= 200 &&
              insidePolygon(x + dc * res, y - dr * res, rings)
            )
              neighbours.push(value);
          }
        const z = quantile(neighbours, 0.5);
        if (Math.abs(z - raw) > 0.75) rough++;
        samples.push({ x, y, z, ground });
      }
    }
    if (!continueWork()) return null;
    // Entire unsupported footprints remain with their existing fallback data.
    if (
      interior < 20 ||
      invalid > interior * 0.02 ||
      rough > samples.length * 0.12
    )
      return null;
    allGround.push(...samples.map((p) => p.ground));
    const sampleIndex = new Map(
      samples.map((p) => [
        `${Math.floor(p.x / res)},${Math.floor(p.y / res)}`,
        p,
      ]),
    );
    function supported(x: number, y: number) {
      // A rotated corner can be up to sqrt(2) times (erosion + one
      // pixel) from the nearest interior cell, without any missing coverage.
      const distance = Math.max(
        2.5,
        Math.SQRT2 * (Math.min(1.5, res * 0.65) + res),
      );
      const steps = Math.ceil(distance / res);
      const cx = Math.floor(x / res),
        cy = Math.floor(y / res);
      for (let dx = -steps; dx <= steps; dx++)
        for (let dy = -steps; dy <= steps; dy++) {
          const p = sampleIndex.get(`${cx + dx},${cy + dy}`);
          if (p && Math.hypot(p.x - x, p.y - y) <= distance) return true;
        }
      return false;
    }
    const leaves: Array<{ bounds: Bounds; plane: Plane }> = [];
    function divide(box: Bounds, selected: Sample[], depth: number): boolean {
      if (!continueWork()) return false;
      const pieces = triangles
        .map((triangle) => clipBounds(triangle, box))
        .filter((p) => p.length >= 3 && area(p) > 1e-7);
      if (!pieces.length) return true;
      let used = selected;
      if (used.length < 6) {
        // Reconstruct only a narrow unsampled edge, never a distant hidden roof.
        const centreX = (box[0] + box[2]) / 2,
          centreY = (box[1] + box[3]) / 2;
        let stillWorking = true;
        used = samples
          .filter((p, index) => {
            if (index % 256 === 0) stillWorking = continueWork();
            return (
              stillWorking &&
              Math.hypot(
                Math.max(box[0] - p.x, 0, p.x - box[2]),
                Math.max(box[1] - p.y, 0, p.y - box[3]),
              ) <=
                res * 2
            );
          })
          .sort(
            (a, b) =>
              Math.hypot(a.x - centreX, a.y - centreY) -
              Math.hypot(b.x - centreX, b.y - centreY),
          )
          .slice(0, 24);
      }
      if (!continueWork()) return false;
      const fit = fitPlane(used);
      if (!continueWork()) return false;
      if (fit) {
        const residual: number[] = [];
        for (const [index, p] of used.entries()) {
          if (index % 256 === 0 && !continueWork()) return false;
          residual.push(Math.abs(planeAt(fit, p.x, p.y) - p.z));
        }
        if (
          quantile(residual, 0.95) <= 0.35 + res * 0.12 &&
          quantile(residual, 0.5) <= 0.2 + res * 0.05
        ) {
          leaves.push({ bounds: box, plane: fit });
          return leaves.length <= 256;
        }
      }
      if (!continueWork()) return false;
      if (leaves.length >= 256) return false;
      if (depth >= 9 || Math.max(box[2] - box[0], box[3] - box[1]) < res * 3) {
        // A real height discontinuity cannot be forced into one inclined plane.
        // Preserve the measured raster cells here; the native/effective spacing
        // remains explicit, and the final footprint and geometry caps still apply.
        const c0 = Math.floor(box[0] / res),
          c1 = Math.floor(box[2] / res);
        const r0 = Math.floor(box[1] / res),
          r1 = Math.floor(box[3] / res);
        for (let cy = r0; cy <= r1; cy++)
          for (let cx = c0; cx <= c1; cx++) {
            if (!continueWork()) return false;
            const cell: Bounds = [
              Math.max(box[0], cx * res),
              Math.max(box[1], cy * res),
              Math.min(box[2], (cx + 1) * res),
              Math.min(box[3], (cy + 1) * res),
            ];
            if (
              cell[2] <= cell[0] ||
              cell[3] <= cell[1] ||
              !triangles.some((t) => area(clipBounds(t, cell)) > 1e-7)
            )
              continue;
            const x = (cx + 0.5) * res,
              y = (cy + 0.5) * res;
            let nearest: Sample | undefined,
              distance = Infinity;
            for (const [index, sample] of samples.entries()) {
              if (index % 256 === 0 && !continueWork()) return false;
              const d = Math.hypot(sample.x - x, sample.y - y);
              if (d < distance) {
                nearest = sample;
                distance = d;
              }
            }
            if (!nearest || distance > res * 2) return false;
            leaves.push({ bounds: cell, plane: { a: 0, b: 0, c: nearest.z } });
            if (leaves.length > 256) return false;
          }
        return true;
      }
      const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
      const mid = (box[axis] + box[axis + 2]) / 2;
      const low = [...box] as Bounds,
        high = [...box] as Bounds;
      low[axis + 2] = mid;
      high[axis] = mid;
      return (
        divide(
          low,
          selected.filter((p) => (axis ? p.y : p.x) < mid),
          depth + 1,
        ) &&
        divide(
          high,
          selected.filter((p) => (axis ? p.y : p.x) >= mid),
          depth + 1,
        )
      );
    }
    if (!divide(bounds, samples, 0)) return null;
    const minSample = Math.min(...samples.map((p) => p.z));
    const maxSample = Math.max(...samples.map((p) => p.z));
    let reconstructedArea = 0;
    for (const leaf of leaves) {
      if (!continueWork()) return null;
      const pieces = triangles
        .map((triangle) => clipBounds(triangle, leaf.bounds))
        .filter((piece) => piece.length >= 3 && area(piece) > 1e-7);
      const merged = mergeLeafPieces(pieces);
      if (!merged) return null;
      for (const patch of merged) {
        const rings = [patch.outer, ...patch.holes];
        const flat: number[] = [],
          holeIndices: number[] = [];
        for (const [index, ring] of rings.entries()) {
          if (index) holeIndices.push(flat.length / 2);
          flat.push(...ring.flat());
        }
        triangleCount += earcut(flat, holeIndices).length / 3;
        if (triangleCount > MAX_BUILDING_SURFACES) return null;
        function elevated(ring: Point[]): RoofSurface["outer"] | null {
          const result: RoofSurface["outer"] = [];
          for (const [x, y] of ring) {
            if (!continueWork()) return null;
            if (!supported(x, y)) return null;
            const elevation = planeAt(leaf.plane, x, y);
            if (
              !Number.isFinite(elevation) ||
              elevation < -100 ||
              elevation > 1000 ||
              elevation < minSample - 2 ||
              elevation > maxSample + 2
            )
              return null;
            result.push({
              ...fromLambert93(x + origin[0], y + origin[1]),
              elevation,
            });
            maxElevation = Math.max(maxElevation, elevation);
          }
          result.push({ ...result[0] });
          return result;
        }
        const outer = elevated(patch.outer),
          inner = patch.holes.map(elevated);
        if (!outer || inner.some((ring) => !ring)) return null;
        surfaces.push({ outer, holes: inner as RoofSurface["holes"] });
        reconstructedArea +=
          area(patch.outer) -
          patch.holes.reduce((sum, ring) => sum + area(ring), 0);
      }
    }
    const expectedArea = triangles.reduce(
      (sum, triangle) => sum + area(triangle),
      0,
    );
    if (
      !expectedArea ||
      Math.abs(reconstructedArea - expectedArea) > expectedArea * 1e-6
    )
      return null;
  }
  if (!surfaces.length || !allGround.length) return null;
  const groundElevation = quantile(allGround, 0.05);
  if (!continueWork() || !Number.isFinite(groundElevation)) return null;
  return {
    surfaces,
    groundElevation,
    maxElevation,
    triangleCount,
  };
}

export async function enrichIGNRoofs(
  elements: OverpassElement[],
  bbox: BBox,
  signal: AbortSignal,
  options: { grid?: IGNRoofGrid; cpuBudgetMs?: number } = {},
): Promise<IGNRoofEnrichment> {
  signal.throwIfAborted();
  const cpuBudgetMs = Math.max(
    0,
    Math.min(12000, options.cpuBudgetMs ?? 12000),
  );
  const startedAt = Date.now();
  const result: IGNRoofEnrichment = {
    elements,
    buildingCount: 0,
    surfaceCount: 0,
    triangleCount: 0,
    resolutionM: null,
    warnings: [],
    sources: [],
  };
  if (bbox[0] < 41 || bbox[2] > 51.2 || bbox[1] < -5.5 || bbox[3] > 9.7)
    return result;
  if (!cpuBudgetMs) {
    result.warnings.push(
      "Reconstruction LiDAR non exécutée dans le temps de collecte disponible ; les données déjà acquises sont conservées.",
    );
    return result;
  }
  const ways = new Map(
    elements.filter((e) => e.type === "way").map((e) => [e.id, e]),
  );
  const candidates = elements.filter(
    (e) =>
      (e.tags?.building || e.tags?.["building:part"]) &&
      e.tags?.building !== "no" &&
      e.tags?.location !== "underground" &&
      e.tags?.parking !== "underground" &&
      e.tags?.tunnel !== "yes" &&
      !(Number(e.tags?.layer) < 0) &&
      !(Number(e.tags?.["building:levels"]) <= 0) &&
      !e.roofSurfaces?.length &&
      !e.measuredSolid &&
      elementPolygons(e, ways).length,
  );
  if (!candidates.length) return result;
  const memberWays = new Set(
    candidates
      .filter((e) => e.type === "relation")
      .flatMap((e) =>
        (e.members ?? []).filter((m) => m.type === "way").map((m) => m.ref),
      ),
  );
  const selected = candidates.filter(
    (e) => e.type !== "way" || !memberWays.has(e.id),
  );
  const vertexCount = (surfaces: RoofSurface[]) =>
    surfaces.reduce(
      (sum, surface) =>
        sum +
        surface.outer.length +
        surface.holes.reduce((n, ring) => n + ring.length, 0),
      0,
    );
  // Import counts both representations when a measured solid also carries roofs.
  // Include holes and repeated closing vertices, exactly as validateRoofData does.
  let importVertices = 0,
    importBuildings = 0;
  for (const element of elements) {
    if (element.roofSurfaces == null && element.measuredSolid == null) continue;
    importBuildings++;
    importVertices +=
      vertexCount(element.roofSurfaces ?? []) +
      vertexCount(element.measuredSolid?.surfaces ?? []);
  }
  const footprintArea = (e: OverpassElement) =>
    elementPolygons(e, ways).reduce((sum, p) => {
      const ring = p.outer.map((v) => toLambert93(v.lon, v.lat));
      const origin = ring[0];
      return sum + area(ring.map(([x, y]) => [x - origin[0], y - origin[1]]));
    }, 0);
  const areas = new Map(selected.map((e) => [e, footprintArea(e)]));
  selected.sort((a, b) => areas.get(b)! - areas.get(a)!);
  let grid: IGNRoofGrid;
  try {
    grid = options.grid ?? (await fetchIGNRoofGrid(bbox, signal));
  } catch {
    signal.throwIfAborted();
    result.warnings.push(
      "Toitures LiDAR IGN indisponibles ; les géométries 3D existantes et les hauteurs habituelles sont conservées.",
    );
    return result;
  }
  result.resolutionM = grid.resolutionM;
  const enriched = new Map<OverpassElement, OverpassElement>();
  const stop = options.grid
    ? startedAt + cpuBudgetMs
    : Date.now() + cpuBudgetMs;
  let processed = 0,
    rejected = 0,
    budgetRejected = 0,
    timeExpired = false;
  for (const element of selected.slice(0, MAX_BUILDINGS)) {
    // A pending timer/abort must be observed before each synchronous footprint.
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (Date.now() >= stop) {
      timeExpired = true;
      break;
    }
    if (result.triangleCount >= MAX_SURFACES) break;
    processed++;
    const roof = reconstructIGNRoof(
      element,
      grid,
      ways,
      () => Date.now() < stop && !signal.aborted,
    );
    // Deliver timer cancellation before accepting even a successfully computed roof.
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (Date.now() >= stop) {
      timeExpired = true;
      break;
    }
    if (!roof) {
      rejected++;
      continue;
    }
    const addedVertices = vertexCount(roof.surfaces);
    const addedBuilding =
      element.roofSurfaces == null && element.measuredSolid == null ? 1 : 0;
    if (
      result.triangleCount + roof.triangleCount > MAX_SURFACES ||
      importVertices + addedVertices > MAX_ROOF_VERTICES ||
      importBuildings + addedBuilding > MAX_ROOF_BUILDINGS
    ) {
      budgetRejected++;
      continue;
    }
    enriched.set(element, {
      ...element,
      roofSurfaces: roof.surfaces,
      groundElevation: roof.groundElevation,
      roofSource: IGN_ROOF_SOURCE,
      tags: {
        ...element.tags,
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_resolution_m": String(grid.resolutionM),
        // The 95th-percentile plane-fit acceptance threshold bounds reconstruction
        // joints; it is not a claim about the LiDAR measurement accuracy.
        "printmap:roof_fit_tolerance_m": String(0.35 + grid.resolutionM * 0.12),
        height: String(
          Math.round((roof.maxElevation - roof.groundElevation) * 100) / 100,
        ),
        "printmap:height_source":
          "IGN LiDAR HD · surface de toiture reconstruite",
      },
    });
    result.buildingCount++;
    result.surfaceCount += roof.surfaces.length;
    result.triangleCount += roof.triangleCount;
    importVertices += addedVertices;
    importBuildings += addedBuilding;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
  result.elements = elements.map((e) => enriched.get(e) ?? e);
  if (result.buildingCount) {
    result.sources.push(IGN_ROOF_SOURCE);
    result.warnings.push(
      `Toitures reconstruites depuis la surface LiDAR IGN : source au pas de 0,5 m, grille utilisée ${grid.resolutionM.toLocaleString("fr-FR")} m. Le sursol peut comporter de la végétation ; les façades et parties masquées ne sont pas relevées par cette reconstruction.`,
    );
  }
  if (rejected)
    result.warnings.push(
      `${rejected} bâtiment(s) sans surface LiDAR suffisamment fiable ; leur représentation précédente est conservée.`,
    );
  if (budgetRejected)
    result.warnings.push(
      `${budgetRejected} reconstruction(s) LiDAR non ajoutée(s) pour respecter les budgets de géométrie et d’import du projet ; les géométries 3D existantes et les hauteurs précédentes sont conservées.`,
    );
  if (timeExpired)
    result.warnings.push(
      "Reconstruction LiDAR interrompue à la limite du temps CPU disponible ; les données déjà acquises sont conservées.",
    );
  if (processed < selected.length)
    result.warnings.push(
      `Reconstruction LiDAR bornée à ${processed} bâtiments examinés et ${MAX_SURFACES.toLocaleString("fr-FR")} triangles maximum ; les autres hauteurs et géométries restent disponibles.`,
    );
  return result;
}
