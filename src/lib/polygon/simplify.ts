import type { Point2D } from "@/types/geometry";

/**
 * Douglas-Peucker polyline simplification.
 * Removes points that deviate less than `tolerance` from the simplified line.
 */
export function simplifyPolyline(
  points: Point2D[],
  tolerance: number,
): Point2D[] {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line (first → last)
  const [sx, sz] = points[0];
  const [ex, ez] = points[points.length - 1];
  const dx = ex - sx;
  const dz = ez - sz;
  const lenSq = dx * dx + dz * dz;

  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    let dist: number;
    if (lenSq === 0) {
      // Start and end are the same point
      const px = points[i][0] - sx;
      const pz = points[i][1] - sz;
      dist = Math.sqrt(px * px + pz * pz);
    } else {
      // Perpendicular distance to the line
      const t = Math.max(
        0,
        Math.min(
          1,
          ((points[i][0] - sx) * dx + (points[i][1] - sz) * dz) / lenSq,
        ),
      );
      const projX = sx + t * dx;
      const projZ = sz + t * dz;
      const px = points[i][0] - projX;
      const pz = points[i][1] - projZ;
      dist = Math.sqrt(px * px + pz * pz);
    }

    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyPolyline(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPolyline(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }

  return [points[0], points[points.length - 1]];
}

/**
 * Compute the total length of a polyline.
 */
export function polylineLength(points: Point2D[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dz = points[i][1] - points[i - 1][1];
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}
