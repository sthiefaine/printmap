import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import { pointInPolygon } from "../polygon/point-in-polygon";
import { repairCoincident } from "./repair-coincident";
import { repairCollinear } from "./repair-collinear";
interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
export interface MappedRetainingWallOptions {
  polylineMm: Point2D[];
  clip: CrossSection;
  resolutionMm: number;
  surfaceAt: (x: number, y: number) => number;
  terrainMaxZ: number;
  foundationZ: number;
  /** Inventory maximum is only a rejection bound, never a constant wall height. */
  sourceMaxHeightMm?: number;
  sourceVerticalUncertaintyMm?: number;
}
export interface MappedRetainingWall {
  mode: "estimated-from-dem";
  solid: Manifold;
  cutter: Manifold;
  section: CrossSection;
  surfaceAt: (x: number, y: number) => number;
  contains: (x: number, y: number) => boolean;
  minimumHeightMm: number;
  maximumHeightMm: number;
  highSide: "left" | "right";
  widthMm: number;
  sampleCount: number;
  topVertices: Point2D[];
  topEdges: [Point2D, Point2D][];
  maxZ: number;
}
function median(values: number[]) {
  const a = values.slice().sort((x, y) => x - y),
    n = Math.floor(a.length / 2);
  return a.length % 2 ? a[n] : (a[n - 1] + a[n]) / 2;
}
/** Reconstruct a terrain break only along an explicitly mapped retaining wall. */
export function makeMappedRetainingWall(
  cad: ManifoldToplevel,
  owner: Handles,
  options: MappedRetainingWallOptions,
): MappedRetainingWall | null {
  const { polylineMm: path, resolutionMm: resolution, foundationZ } = options;
  if (
    path.length < 2 ||
    !path.every((p) => p.length === 2 && p.every(Number.isFinite)) ||
    ![resolution, foundationZ, options.terrainMaxZ].every(Number.isFinite) ||
    resolution <= 0 ||
    foundationZ < 0 ||
    options.terrainMaxZ <= foundationZ ||
    options.clip.isEmpty() ||
    (options.sourceMaxHeightMm != null &&
      (!Number.isFinite(options.sourceMaxHeightMm) ||
        options.sourceMaxHeightMm <= 0)) ||
    (options.sourceVerticalUncertaintyMm != null &&
      (!Number.isFinite(options.sourceVerticalUncertaintyMm) ||
        options.sourceVerticalUncertaintyMm < 0))
  )
    return null;
  const distances = [0],
    normals: Point2D[] = [];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0],
      dy = path[i][1] - path[i - 1][1],
      length = Math.hypot(dx, dy);
    if (length < 0.00001) return null;
    distances.push(distances.at(-1)! + length);
    normals.push([-dy / length, dx / length]);
    if (
      i > 1 &&
      normals[i - 2][0] * normals[i - 1][0] +
        normals[i - 2][1] * normals[i - 1][1] <
        -0.5
    )
      return null;
  }
  const total = distances.at(-1)!;
  if (total < resolution) return null;
  const at = (distance: number) => {
    let segment = 0;
    while (
      segment + 1 < path.length - 1 &&
      distance > distances[segment + 1] + 1e-6
    )
      segment++;
    const t =
      (distance - distances[segment]) /
      (distances[segment + 1] - distances[segment]);
    let normal = normals[segment],
      miter = 1;
    const node = distances.findIndex(
      (d, i) => i > 0 && i < path.length - 1 && Math.abs(d - distance) < 1e-6,
    );
    if (node >= 0) {
      const sum: Point2D = [
          normals[node - 1][0] + normals[node][0],
          normals[node - 1][1] + normals[node][1],
        ],
        length = Math.hypot(...sum);
      normal = [sum[0] / length, sum[1] / length];
      miter = Math.min(
        3,
        1 / (normal[0] * normals[node][0] + normal[1] * normals[node][1]),
      );
    }
    return {
      segment,
      t,
      point: [
        path[segment][0] + t * (path[segment + 1][0] - path[segment][0]),
        path[segment][1] + t * (path[segment + 1][1] - path[segment][1]),
      ] as Point2D,
      normal,
      miter,
    };
  };
  // Short source segments cannot carry a full raster-cell miter: the offset
  // would fold over its neighbour. Keep the centreline exact and narrow only
  // the local replacement band, interpolating its outer edges continuously.
  const outerNodes = distances.map((distance, i) => {
    const st = at(distance);
    const previous = i ? distances[i] - distances[i - 1] : Infinity;
    const next =
      i + 1 < path.length ? distances[i + 1] - distances[i] : Infinity;
    const width =
      Math.min(resolution, 0.45 * Math.min(previous, next)) / st.miter;
    return [1, -1].map(
      (sign) =>
        [
          st.point[0] + sign * st.normal[0] * st.miter * width,
          st.point[1] + sign * st.normal[1] * st.miter * width,
        ] as Point2D,
    );
  });
  const stops = [...distances];
  for (
    let distance = resolution / 2;
    distance < total;
    distance += resolution / 2
  )
    stops.push(distance);
  stops.sort((a, b) => a - b);
  const stations = stops
    .filter((d, i) => !i || d - stops[i - 1] > 1e-5)
    .map(at);
  let sampleCount = 0;
  const sample = (
    st: ReturnType<typeof at>,
    sign: number,
    distance: number,
  ) => {
    const values: number[] = [];
    for (const shift of [-0.25, 0, 0.25]) {
      const z = options.surfaceAt(
        st.point[0] +
          sign * st.normal[0] * distance +
          st.normal[1] * shift * resolution,
        st.point[1] +
          sign * st.normal[1] * distance -
          st.normal[0] * shift * resolution,
      );
      if (!Number.isFinite(z) || z < foundationZ) return null;
      values.push(z);
      sampleCount++;
    }
    return median(values);
  };
  const profiles: { left: number; right: number }[] = [];
  for (const st of stations) {
    const values: number[][] = [[], []];
    for (let side = 0; side < 2; side++)
      for (const factor of [1, 1.5, 2, 2.5, 3]) {
        const z = sample(st, side === 0 ? 1 : -1, factor * resolution);
        if (z == null) return null;
        values[side].push(z);
      }
    const medians = values.map(median),
      high = medians[0] >= medians[1] ? 0 : 1,
      low = 1 - high;
    // Sample farther into the high plateau. On the low side use the lowest stable
    // three-point road profile, excluding the opposite street edge or another wall.
    const levels: number[] = [];
    levels[high] = median(values[high].slice(2));
    levels[low] = Math.min(...values[low]);
    profiles.push({ left: levels[0], right: levels[1] });
  }
  const signs = profiles.map((p) => Math.sign(p.left - p.right));
  const highLeft = median(signs) > 0;
  const heights = profiles.map((p) => Math.abs(p.left - p.right));
  if (
    median(heights) < 0.12 ||
    profiles.some(
      (p) => (highLeft ? p.left - p.right : p.right - p.left) < -0.12,
    ) ||
    heights.some(
      (height) =>
        options.sourceMaxHeightMm != null &&
        height >
          options.sourceMaxHeightMm +
            (options.sourceVerticalUncertaintyMm ?? 0),
    )
  )
    return null;
  const handles: { delete(): void }[] = [],
    outputs = new Set<{ delete(): void }>();
  const arena: Handles = {
    keep(h) {
      handles.push(h);
      return h;
    },
  };
  try {
    // A two-micron interval represents a sharp terrain break without collapsed
    // triangles when the same wall is exported to Float32 millimetre coordinates.
    const gap = 0.001,
      points: Point2D[][] = [],
      levels: number[][] = [];
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i],
        offsets = [resolution, gap, -gap, -resolution];
      const row = offsets.map(
        (offset) =>
          [
            st.point[0] + st.normal[0] * st.miter * offset,
            st.point[1] + st.normal[1] * st.miter * offset,
          ] as Point2D,
      );
      for (const [col, side] of [
        [0, 0],
        [3, 1],
      ]) {
        const a = outerNodes[st.segment][side],
          b = outerNodes[st.segment + 1][side];
        row[col] = [a[0] + st.t * (b[0] - a[0]), a[1] + st.t * (b[1] - a[1])];
      }
      const leftOuter = options.surfaceAt(...row[0]),
        rightOuter = options.surfaceAt(...row[3]);
      if (
        ![leftOuter, rightOuter].every(Number.isFinite) ||
        Math.min(leftOuter, rightOuter) < foundationZ
      )
        return null;
      points.push(row);
      levels.push([leftOuter, profiles[i].left, profiles[i].right, rightOuter]);
    }
    const ring = [
      ...points.map((row) => row[0]),
      ...points
        .slice()
        .reverse()
        .map((row) => row[3]),
    ];
    let section = arena.keep(
      arena
        .keep(new cad.CrossSection([ring], "NonZero"))
        .intersect(options.clip),
    );
    if (section.isEmpty()) return null;
    const count = points.length * 4,
      p: number[] = [],
      triangles: number[] = [];
    for (const top of [false, true])
      for (let row = 0; row < points.length; row++)
        for (let col = 0; col < 4; col++)
          p.push(
            ...points[row][col],
            top ? levels[row][col] : foundationZ - 0.005,
          );
    const quad = (a: number, b: number, c: number, d: number) => {
      triangles.push(a, b, c, a, c, d);
    };
    for (let row = 0; row < points.length - 1; row++) {
      const a = row * 4,
        b = (row + 1) * 4;
      for (let col = 0; col < 3; col++) {
        quad(a + col, b + col, b + col + 1, a + col + 1);
        quad(
          a + col + count,
          a + col + 1 + count,
          b + col + 1 + count,
          b + col + count,
        );
      }
      quad(a + 3, b + 3, b + 3 + count, a + 3 + count);
      quad(b, a, a + count, b + count);
    }
    for (let col = 0; col < 3; col++) {
      quad(col, col + 1, col + 1 + count, col + count);
      quad(
        count - 4 + col + 1,
        count - 4 + col,
        2 * count - 4 + col,
        2 * count - 4 + col + 1,
      );
    }
    const properties = new Float32Array(p);
    let solid = arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: properties,
          triVerts: new Uint32Array(triangles),
        }),
      ),
    );
    const maxZ = Math.max(options.terrainMaxZ, ...levels.flat());
    const column = arena.keep(
      arena
        .keep(section.extrude(maxZ - foundationZ + 1))
        .translate([0, 0, foundationZ - 0.005]),
    );
    solid = arena.keep(solid.intersect(column));
    // Replace the entire bounded strip above the common foundation. The insert
    // restores its terrain volume; no coincident internal subtraction is needed.
    let cutter = column;
    const clean = (shape: Manifold) =>
      arena.keep(
        new cad.Manifold(
          repairCollinear(
            cad,
            repairCoincident(
              cad,
              arena
                .keep(arena.keep(shape.setTolerance(0.0001)).simplify(0.0001))
                .getMesh(),
            ),
          ),
        ),
      );
    solid = clean(solid);
    // Use the repaired Float32 footprint; the original offset ribbon can differ
    // by one ULP at a turn. Keep a five-micron peripheral overlap with the
    // untouched terrain, instead of introducing a coincident vertical seam.
    section = arena.keep(solid.project());
    cutter = clean(
      arena.keep(
        arena
          .keep(
            arena
              .keep(section.offset(-0.005, "Miter"))
              .extrude(maxZ - foundationZ + 1),
          )
          .translate([0, 0, foundationZ - 0.005]),
      ),
    );
    if (
      solid.status() !== "NoError" ||
      solid.isEmpty() ||
      cutter.status() !== "NoError"
    )
      return null;
    // Terrain sampling and foundation intersections use the repaired top facets,
    // including any extra vertices introduced where an offset ribbon bends.
    const mesh = solid.getMesh();
    const topProperties = mesh.vertProperties;
    const tops: [number, number, number][] = [];
    for (let face = 0; face < mesh.triVerts.length; face += 3) {
      const a = mesh.triVerts[face],
        b = mesh.triVerts[face + 1],
        c = mesh.triVerts[face + 2];
      const signedArea =
        (topProperties[b * 3] - topProperties[a * 3]) *
          (topProperties[c * 3 + 1] - topProperties[a * 3 + 1]) -
        (topProperties[b * 3 + 1] - topProperties[a * 3 + 1]) *
          (topProperties[c * 3] - topProperties[a * 3]);
      if (signedArea > 1e-15) tops.push([a, b, c]);
    }
    const rings = section.toPolygons();
    const contains = (x: number, y: number) =>
      rings.reduce(
        (inside, ring) => inside !== pointInPolygon(x, y, ring),
        false,
      );
    const surfaceAt = (x: number, y: number) => {
      if (!contains(x, y)) return options.surfaceAt(x, y);
      for (const [a, b, c] of tops) {
        const ax = topProperties[a * 3],
          ay = topProperties[a * 3 + 1],
          bx = topProperties[b * 3],
          by = topProperties[b * 3 + 1],
          cx = topProperties[c * 3],
          cy = topProperties[c * 3 + 1];
        const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(denominator) < 1e-15) continue;
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator,
          v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
          return (
            u * topProperties[a * 3 + 2] +
            v * topProperties[b * 3 + 2] +
            (1 - u - v) * topProperties[c * 3 + 2]
          );
      }
      return options.surfaceAt(x, y);
    };
    const topVertices: Point2D[] = [],
      topEdges: [Point2D, Point2D][] = [];
    const topPoints = new Map<number, Point2D>();
    for (const face of tops) {
      for (const vertex of face) {
        if (!topPoints.has(vertex)) {
          const point: Point2D = [
            topProperties[vertex * 3],
            topProperties[vertex * 3 + 1],
          ];
          topPoints.set(vertex, point);
          topVertices.push(point);
        }
      }
      for (let edge = 0; edge < 3; edge++)
        topEdges.push([
          topPoints.get(face[edge])!,
          topPoints.get(face[(edge + 1) % 3])!,
        ]);
    }
    for (const h of [solid, cutter, section]) {
      owner.keep(h);
      outputs.add(h);
    }
    return {
      mode: "estimated-from-dem",
      solid,
      cutter,
      section,
      surfaceAt,
      contains,
      minimumHeightMm: Math.min(...heights),
      maximumHeightMm: Math.max(...heights),
      highSide: highLeft ? "left" : "right",
      widthMm: Math.max(
        ...outerNodes.map(([left, right]) =>
          Math.hypot(left[0] - right[0], left[1] - right[1]),
        ),
      ),
      sampleCount,
      topVertices,
      topEdges,
      maxZ,
    };
  } catch {
    return null;
  } finally {
    for (let i = handles.length - 1; i >= 0; i--)
      if (!outputs.has(handles[i])) handles[i].delete();
  }
}
