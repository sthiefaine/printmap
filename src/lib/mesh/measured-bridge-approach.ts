import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { RoadData } from "@/lib/osm/parse-elements";
import { pointInPolygon } from "../polygon/point-in-polygon";
import { repairCoincident } from "./repair-coincident";
import { repairCollinear } from "./repair-collinear";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
type ApproachRoad = Pick<
  RoadData,
  "polyline" | "tags" | "roadType" | "isUnderground" | "isBridge" | "sourceId"
>;
export interface BridgeApproachOptions {
  footprint: CrossSection;
  clip: CrossSection;
  /** A point and direction on the carried road. */
  center: Point2D;
  axis: Point2D;
  roads: ApproachRoad[];
  /** Restrict the correction to the documented width of the passage. */
  spanMm: number;
  resolutionMm: number;
  terrainMaxZ: number;
  foundationZ: number;
  surfaceAt: (x: number, y: number) => number;
}
export interface MeasuredBridgeApproach {
  /** Road grade is estimated from the DEM outside the bridge, not surveyed. */
  mode: "estimated-from-dem";
  center: Point2D;
  groundZ: number;
  axis: Point2D;
  polyline: Point2D[];
  section: CrossSection;
  floorSolid: Manifold;
  cutter: Manifold;
  surfaceAt: (x: number, y: number) => number;
  sourceIds: string[];
  sampleCount: number;
  sampleSpreadMm: number;
  slopePercent: number;
  correctionLengthMm: number;
}

function median(values: number[]) {
  const ordered = values.slice().sort((a, b) => a - b),
    mid = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[mid]
    : (ordered[mid - 1] + ordered[mid]) / 2;
}
function crossing(a: Point2D, b: Point2D, c: Point2D, d: Point2D) {
  const u: Point2D = [b[0] - a[0], b[1] - a[1]],
    v: Point2D = [d[0] - c[0], d[1] - c[1]];
  const determinant = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(determinant) < 1e-10) return null;
  const w: Point2D = [c[0] - a[0], c[1] - a[1]];
  const along = (w[0] * v[1] - w[1] * v[0]) / determinant;
  const other = (w[0] * u[1] - w[1] * u[0]) / determinant;
  return along >= -1e-8 &&
    along <= 1 + 1e-8 &&
    other >= -1e-8 &&
    other <= 1 + 1e-8
    ? Math.max(0, Math.min(1, along))
    : null;
}
function samePoint(a: Point2D, b: Point2D) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.0001;
}

/** Correct only a mapped open underpass and its connected access road. */
export function makeMeasuredBridgeApproach(
  cad: ManifoldToplevel,
  owner: Handles,
  options: BridgeApproachOptions,
): MeasuredBridgeApproach | null {
  const { center, axis, spanMm, resolutionMm, foundationZ, terrainMaxZ } =
    options;
  const norm = Math.hypot(...axis);
  if (
    ![...center, ...axis, spanMm, resolutionMm, foundationZ, terrainMaxZ].every(
      Number.isFinite,
    ) ||
    norm < 1e-6 ||
    spanMm <= 0 ||
    resolutionMm <= 0 ||
    foundationZ < 0 ||
    terrainMaxZ <= foundationZ ||
    options.footprint.isEmpty() ||
    options.clip.isEmpty()
  )
    return null;
  const carried: Point2D = [axis[0] / norm, axis[1] / norm];
  const rings = options.footprint.toPolygons();
  const contains = (p: Point2D) =>
    rings.reduce(
      (inside, ring) => inside !== pointInPolygon(...p, ring),
      false,
    );
  const far =
    spanMm +
    Math.hypot(
      options.footprint.bounds().max[0] - options.footprint.bounds().min[0],
      options.footprint.bounds().max[1] - options.footprint.bounds().min[1],
    );
  const carriedA: Point2D = [
    center[0] - carried[0] * far,
    center[1] - carried[1] * far,
  ];
  const carriedB: Point2D = [
    center[0] + carried[0] * far,
    center[1] + carried[1] * far,
  ];
  let chosen: { road: ApproachRoad; point: Point2D; score: number } | null =
    null;
  for (const road of options.roads) {
    if (
      !road.isUnderground ||
      road.isBridge ||
      !road.tags.name ||
      road.tags.tunnel === "building_passage"
    )
      continue;
    for (let i = 1; i < road.polyline.length; i++) {
      const a = road.polyline[i - 1],
        b = road.polyline[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-5) continue;
      const orthogonal =
        Math.abs(carried[0] * (b[1] - a[1]) - carried[1] * (b[0] - a[0])) /
        length;
      if (orthogonal < 0.7) continue;
      const t = crossing(a, b, carriedA, carriedB);
      if (t == null) continue;
      const point: Point2D = [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
      ];
      if (!contains(point)) continue;
      const score =
        orthogonal -
        (Math.hypot(point[0] - center[0], point[1] - center[1]) /
          Math.max(1, spanMm)) *
          0.1;
      if (!chosen || score > chosen.score) chosen = { road, point, score };
    }
  }
  if (!chosen) return null;
  let path = chosen.road.polyline.map((p) => [...p] as Point2D);
  const used = new Set<ApproachRoad>([chosen.road]);
  const compatible = (road: ApproachRoad) =>
    !used.has(road) &&
    !road.isBridge &&
    road.roadType === chosen!.road.roadType &&
    road.tags.name === chosen!.road.tags.name &&
    road.polyline.length >= 2;
  for (let pass = 0; pass < options.roads.length; pass++) {
    let extended = false;
    for (const road of options.roads) {
      if (!compatible(road)) continue;
      const first = road.polyline[0],
        last = road.polyline.at(-1)!;
      if (samePoint(path.at(-1)!, first)) path.push(...road.polyline.slice(1));
      else if (samePoint(path.at(-1)!, last))
        path.push(...road.polyline.slice(0, -1).reverse());
      else if (samePoint(path[0], last))
        path = [...road.polyline.slice(0, -1), ...path];
      else if (samePoint(path[0], first))
        path = [...road.polyline.slice(1).reverse(), ...path];
      else continue;
      used.add(road);
      extended = true;
    }
    if (!extended) break;
  }
  if (
    path.some(
      (point, i) =>
        !point.every(Number.isFinite) ||
        (i > 0 && samePoint(point, path[i - 1])),
    )
  )
    return null;
  const distances = [0],
    normals: Point2D[] = [];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0],
      dy = path[i][1] - path[i - 1][1],
      length = Math.hypot(dx, dy);
    distances.push(distances.at(-1)! + length);
    normals.push([-dy / length, dx / length]);
    if (
      i > 1 &&
      normals[i - 2][0] * normals[i - 1][0] +
        normals[i - 2][1] * normals[i - 1][1] <
        0.95
    )
      return null;
  }
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
      miter = 1 / (normal[0] * normals[node][0] + normal[1] * normals[node][1]);
    }
    return {
      distance,
      point: [
        path[segment][0] + t * (path[segment + 1][0] - path[segment][0]),
        path[segment][1] + t * (path[segment + 1][1] - path[segment][1]),
      ] as Point2D,
      normal,
      miter,
    };
  };
  const intervals: [number, number][] = [];
  let crossingDistance = 0,
    bestDistance = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1],
      length = distances[i + 1] - distances[i];
    const fractions = [0, 1];
    for (const ring of rings)
      for (let j = 0; j < ring.length; j++) {
        const t = crossing(a, b, ring[j], ring[(j + 1) % ring.length]);
        if (t != null) fractions.push(t);
      }
    fractions.sort((x, y) => x - y);
    for (let j = 0; j < fractions.length - 1; j++) {
      const from = fractions[j],
        to = fractions[j + 1];
      if (to - from < 1e-8) continue;
      if (
        contains([
          a[0] + ((from + to) / 2) * (b[0] - a[0]),
          a[1] + ((from + to) / 2) * (b[1] - a[1]),
        ])
      )
        intervals.push([
          distances[i] + from * length,
          distances[i] + to * length,
        ]);
    }
    const t = Math.max(
      0,
      Math.min(
        1,
        ((chosen.point[0] - a[0]) * (b[0] - a[0]) +
          (chosen.point[1] - a[1]) * (b[1] - a[1])) /
          (length * length),
      ),
    );
    const d = Math.hypot(
      a[0] + t * (b[0] - a[0]) - chosen.point[0],
      a[1] + t * (b[1] - a[1]) - chosen.point[1],
    );
    if (d < bestDistance) {
      bestDistance = d;
      crossingDistance = distances[i] + t * length;
    }
  }
  if (!intervals.length) return null;
  const coveredFrom = Math.min(...intervals.map((i) => i[0])),
    coveredTo = Math.max(...intervals.map((i) => i[1]));
  const from = coveredFrom - 2 * resolutionMm,
    to = coveredTo + 2 * resolutionMm;
  if (from < resolutionMm / 2 || to > distances.at(-1)! - resolutionMm / 2)
    return null;
  const samples: number[] = [];
  const sample = (distance: number) => {
    const values: number[] = [];
    for (const shift of [-0.5, 0, 0.5]) {
      const st = at(distance + shift * resolutionMm);
      for (const across of [-spanMm / 8, 0, spanMm / 8]) {
        const z = options.surfaceAt(
          st.point[0] + across * st.normal[0],
          st.point[1] + across * st.normal[1],
        );
        if (!Number.isFinite(z) || z < foundationZ) return null;
        values.push(z);
        samples.push(z);
      }
    }
    return median(values);
  };
  const z0 = sample(from),
    z1 = sample(to);
  if (z0 == null || z1 == null) return null;
  const slope = (z1 - z0) / (to - from);
  if (Math.abs(slope) > 0.08) return null;
  const grade = (distance: number) => z0 + (distance - from) * slope;
  const nearest = (x: number, y: number) => {
    let nearestDistance = from,
      best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        b = path[i + 1],
        dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = distances[i + 1] - distances[i];
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length * length)),
      );
      const delta = (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2;
      if (delta < best) {
        best = delta;
        nearestDistance = distances[i] + t * length;
      }
    }
    return Math.max(from, Math.min(to, nearestDistance));
  };
  const handles: { delete(): void }[] = [],
    outputs = new Set<{ delete(): void }>();
  const arena: Handles = {
    keep(handle) {
      handles.push(handle);
      return handle;
    },
  };
  try {
    const stations = [
      from,
      ...distances.filter((d) => d > from + 1e-6 && d < to - 1e-6),
      to,
    ].map(at);
    const positions: number[] = [],
      triangles: number[] = [];
    const boundary = stations.map((st) =>
      [1, -1].map(
        (sign) =>
          [
            st.point[0] + (sign * st.normal[0] * st.miter * spanMm) / 2,
            st.point[1] + (sign * st.normal[1] * st.miter * spanMm) / 2,
          ] as Point2D,
      ),
    );
    const ring = [
      ...boundary.map((b) => b[0]),
      ...boundary
        .slice()
        .reverse()
        .map((b) => b[1]),
    ];
    const rawSection = arena.keep(new cad.CrossSection([ring], "NonZero"));
    const section = arena.keep(rawSection.intersect(options.clip));
    if (section.isEmpty()) return null;
    for (const top of [false, true])
      for (let i = 0; i < stations.length; i++)
        for (const point of boundary[i])
          positions.push(
            ...point,
            top ? grade(stations[i].distance) : foundationZ - 0.005,
          );
    const n = stations.length * 2;
    const quad = (a: number, b: number, c: number, d: number) =>
      triangles.push(a, b, c, a, c, d);
    for (let i = 0; i < stations.length - 1; i++) {
      const a = i * 2,
        b = (i + 1) * 2;
      quad(a, b, b + 1, a + 1);
      quad(a + n, a + n + 1, b + n + 1, b + n);
      quad(a + 1, b + 1, b + 1 + n, a + 1 + n);
      quad(b, a, a + n, b + n);
    }
    quad(0, 1, 1 + n, n);
    quad(n - 1, n - 2, 2 * n - 2, 2 * n - 1);
    let floorSolid = arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: new Float32Array(positions),
          triVerts: new Uint32Array(triangles),
        }),
      ),
    );
    const column = arena.keep(
      arena
        .keep(section.extrude(Math.max(terrainMaxZ, z0, z1) - foundationZ + 1))
        .translate([0, 0, foundationZ - 0.005]),
    );
    floorSolid = arena.keep(floorSolid.intersect(column));
    let cutter = arena.keep(column.subtract(floorSolid));
    floorSolid = arena.keep(
      arena.keep(floorSolid.setTolerance(0.0001)).simplify(0.0001),
    );
    floorSolid = arena.keep(
      new cad.Manifold(
        repairCollinear(cad, repairCoincident(cad, floorSolid.getMesh())),
      ),
    );
    cutter = arena.keep(
      arena.keep(cutter.setTolerance(0.0001)).simplify(0.0001),
    );
    cutter = arena.keep(
      new cad.Manifold(
        repairCollinear(cad, repairCoincident(cad, cutter.getMesh())),
      ),
    );
    if (
      floorSolid.status() !== "NoError" ||
      floorSolid.isEmpty() ||
      cutter.status() !== "NoError"
    )
      return null;
    for (const handle of [section, floorSolid, cutter]) {
      owner.keep(handle);
      outputs.add(handle);
    }
    return {
      mode: "estimated-from-dem",
      center: chosen.point,
      axis: carried,
      groundZ: grade(crossingDistance),
      polyline: path,
      section,
      floorSolid,
      cutter,
      surfaceAt: (x, y) => grade(nearest(x, y)),
      sourceIds: [...used].map((road) => road.sourceId ?? "OSM road"),
      sampleCount: samples.length,
      sampleSpreadMm: Math.max(...samples) - Math.min(...samples),
      slopePercent: Math.abs(slope) * 100,
      correctionLengthMm: to - from,
    };
  } catch {
    return null;
  } finally {
    for (let i = handles.length - 1; i >= 0; i--)
      if (!outputs.has(handles[i])) handles[i].delete();
  }
}
