import type { Roof, RoofShape } from "@/lib/osm/building-height";
import type { Ring } from "./features";

/** Smallest rectangle around a footprint: centre, unit vector of its long
 * side, half length and half width. Roofs are laid out in this frame. */
export interface OrientedBox {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  a: number;
  b: number;
}

function convexHull(points: Ring): Ring {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], p: number[], q: number[]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const half = (input: Ring) => {
    const out: Ring = [];
    for (const p of input) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2], out[out.length - 1], p) <= 0
      )
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

export function orientedBox(ring: Ring): OrientedBox {
  const hull = convexHull(ring);
  let best: OrientedBox | null = null,
    bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i],
      q = hull[(i + 1) % hull.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) continue;
    const ux = (q[0] - p[0]) / length,
      uy = (q[1] - p[1]) / length;
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy,
        v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea) continue;
    bestArea = area;
    const cu = (minU + maxU) / 2,
      cv = (minV + maxV) / 2,
      halfU = (maxU - minU) / 2,
      halfV = (maxV - minV) / 2;
    const centre = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux };
    best =
      halfU >= halfV
        ? { ...centre, ux, uy, a: halfU, b: halfV }
        : { ...centre, ux: -uy, uy: ux, a: halfV, b: halfU };
  }
  return best ?? { cx: ring[0][0], cy: ring[0][1], ux: 1, uy: 0, a: 0, b: 0 };
}

export function isConvex(ring: Ring): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      c = ring[(i + 2) % ring.length];
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(turn) < 1e-9) continue;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return sign !== 0;
}

export function centroid(ring: Ring): [number, number] {
  let area = 0,
    x = 0,
    y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const w = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += w;
    x += (ring[j][0] + ring[i][0]) * w;
    y += (ring[j][1] + ring[i][1]) * w;
  }
  return Math.abs(area) < 1e-12
    ? [ring[0][0], ring[0][1]]
    : [x / (3 * area), y / (3 * area)];
}

/** Usual proportions when OSM gives the shape but not its height. */
export function defaultRoofHeightM(shape: RoofShape, shortSideM: number) {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
  switch (shape) {
    case "skillion":
      return clamp(shortSideM * 0.18, 1, 4);
    case "pyramidal":
      return clamp(shortSideM * 0.45, 1.5, 12);
    case "cone":
      return clamp(shortSideM * 0.8, 2, 20);
    case "dome":
      return clamp(shortSideM * 0.5, 1.5, 25);
    default:
      return clamp(shortSideM * 0.3, 1.5, 6);
  }
}

/** Ridge axis (r, half length `ar`), slope axis (s, half width `bs`) and the
 * side of the slope axis that a single-pitch roof raises. */
export interface RoofFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  ar: number;
  sx: number;
  sy: number;
  bs: number;
  high: 1 | -1;
}

export function roofFrame(box: OrientedBox, roof: Roof): RoofFrame {
  const { cx, cy, ux, uy, a, b } = box;
  const vx = -uy,
    vy = ux;
  let ridgeAlongLong = !roof.across,
    high: 1 | -1 = 1;
  let facing: [number, number] | null = null;
  if (roof.direction != null) {
    const bearing = (roof.direction * Math.PI) / 180;
    // Model axes: +X east, +Y north.
    facing = [Math.sin(bearing), Math.cos(bearing)];
    // The slope faces `facing`, so the ridge runs across it.
    ridgeAlongLong =
      Math.abs(facing[0] * ux + facing[1] * uy) <
      Math.abs(facing[0] * vx + facing[1] * vy);
  }
  const frame = ridgeAlongLong
    ? { rx: ux, ry: uy, ar: a, sx: vx, sy: vy, bs: b }
    : { rx: vx, ry: vy, ar: b, sx: ux, sy: uy, bs: a };
  // A single pitch descends towards the way it faces.
  if (facing && facing[0] * frame.sx + facing[1] * frame.sy > 0) high = -1;
  return { cx, cy, ...frame, high };
}

/** Corner points of the convex roof volume over the box, from z = 0 to `h`.
 * Returns null for the round shapes, which are not made of flat faces. */
export function roofHullPoints(
  frame: RoofFrame,
  shape: RoofShape,
  h: number,
): [number, number, number][] | null {
  const { cx, cy, rx, ry, ar, sx, sy, bs, high } = frame;
  const at = (i: number, j: number, z: number): [number, number, number] => [
    cx + i * ar * rx + j * bs * sx,
    cy + i * ar * ry + j * bs * sy,
    z,
  ];
  const corners = [at(-1, -1, 0), at(1, -1, 0), at(1, 1, 0), at(-1, 1, 0)];
  switch (shape) {
    case "gabled":
      return [...corners, at(-1, 0, h), at(1, 0, h)];
    case "hipped": {
      // Hips at 45° in plan: the ridge is shorter by the width of the roof.
      const ridge = ar > 0 ? 1 - Math.min(1, bs / ar) : 0;
      return ridge < 0.05
        ? [...corners, at(0, 0, h)]
        : [...corners, at(-ridge, 0, h), at(ridge, 0, h)];
    }
    case "skillion":
      return [...corners, at(-1, high, h), at(1, high, h)];
    case "pyramidal":
      return [...corners, at(0, 0, h)];
    default:
      return null;
  }
}
