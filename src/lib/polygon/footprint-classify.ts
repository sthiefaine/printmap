import type { Point2D } from "@/types/geometry";
import { signedArea } from "./area";
import {
  RECTANGULARITY_THRESHOLD,
  CONVEXITY_THRESHOLD,
  MAX_RECTANGULAR_VERTICES,
} from "../constants";

export type FootprintClass = "rectangular" | "convex-simple" | "complex";

export interface FootprintClassification {
  footprintClass: FootprintClass;
  rectangularity: number;
  convexity: number;
  dominantAxis: Point2D;
  obbHalfLong: number;
  obbHalfShort: number;
}

// ── Convex Hull (Andrew's monotone chain) ──

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function computeConvexHull(points: Point2D[]): Point2D[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = pts.length;
  if (n <= 2) return pts.slice();

  const lower: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0
    ) {
      lower.pop();
    }
    lower.push(pts[i]);
  }

  const upper: Point2D[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0
    ) {
      upper.pop();
    }
    upper.push(pts[i]);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ── Minimum Area OBB (rotating calipers on convex hull edges) ──

function normalize(v: Point2D): Point2D {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len < 1e-12) return [1, 0];
  return [v[0] / len, v[1] / len];
}

function computeMinAreaOBB(points: Point2D[]): {
  axis: Point2D;
  halfLong: number;
  halfShort: number;
  area: number;
} {
  const hull = computeConvexHull(points);
  if (hull.length < 3) {
    return { axis: [1, 0], halfLong: 0, halfShort: 0, area: 0 };
  }

  let bestArea = Infinity;
  let bestAxis: Point2D = [1, 0];
  let bestHalfLong = 0;
  let bestHalfShort = 0;

  const hn = hull.length;
  for (let i = 0; i < hn; i++) {
    const j = (i + 1) % hn;
    const edgeDir = normalize([
      hull[j][0] - hull[i][0],
      hull[j][1] - hull[i][1],
    ]);
    const perpDir: Point2D = [-edgeDir[1], edgeDir[0]];

    let minAlong = Infinity,
      maxAlong = -Infinity;
    let minPerp = Infinity,
      maxPerp = -Infinity;

    for (const p of hull) {
      const dx = p[0] - hull[0][0];
      const dy = p[1] - hull[0][1];
      const along = dx * edgeDir[0] + dy * edgeDir[1];
      const perp = dx * perpDir[0] + dy * perpDir[1];
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minPerp = Math.min(minPerp, perp);
      maxPerp = Math.max(maxPerp, perp);
    }

    const width = maxAlong - minAlong;
    const height = maxPerp - minPerp;
    const area = width * height;

    if (area < bestArea) {
      bestArea = area;
      if (width >= height) {
        bestAxis = edgeDir;
        bestHalfLong = width / 2;
        bestHalfShort = height / 2;
      } else {
        bestAxis = perpDir;
        bestHalfLong = height / 2;
        bestHalfShort = width / 2;
      }
    }
  }

  return {
    axis: bestAxis,
    halfLong: bestHalfLong,
    halfShort: bestHalfShort,
    area: bestArea,
  };
}

// ── Count significant vertices (remove collinear) ──

function countSignificantVertices(points: Point2D[]): number {
  const n = points.length;
  if (n < 3) return n;

  let count = 0;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const ex1 = curr[0] - prev[0],
      ey1 = curr[1] - prev[1];
    const ex2 = next[0] - curr[0],
      ey2 = next[1] - curr[1];
    const len1 = Math.sqrt(ex1 * ex1 + ey1 * ey1);
    const len2 = Math.sqrt(ex2 * ex2 + ey2 * ey2);

    if (len1 < 1e-10 || len2 < 1e-10) continue;

    const crossVal = Math.abs(ex1 * ey2 - ey1 * ex2) / (len1 * len2);
    if (crossVal > 0.05) count++;
  }

  return count;
}

// ── Main classification ──

export function classifyFootprint(points: Point2D[]): FootprintClassification {
  const polyArea = Math.abs(signedArea(points));
  const hull = computeConvexHull(points);
  const hullArea = Math.abs(signedArea(hull));
  const obb = computeMinAreaOBB(points);

  const rectangularity = obb.area > 1e-10 ? polyArea / obb.area : 0;
  const convexity = hullArea > 1e-10 ? polyArea / hullArea : 0;
  const sigVerts = countSignificantVertices(points);

  let footprintClass: FootprintClass;
  if (
    rectangularity >= RECTANGULARITY_THRESHOLD &&
    sigVerts <= MAX_RECTANGULAR_VERTICES
  ) {
    footprintClass = "rectangular";
  } else if (convexity >= CONVEXITY_THRESHOLD) {
    footprintClass = "convex-simple";
  } else {
    footprintClass = "complex";
  }

  return {
    footprintClass,
    rectangularity,
    convexity,
    dominantAxis: obb.axis,
    obbHalfLong: obb.halfLong,
    obbHalfShort: obb.halfShort,
  };
}
