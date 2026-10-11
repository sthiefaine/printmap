import type { Point2D } from "@/types/geometry";

const EPSILON = 1e-8;

export function cleanPolygon(points: Point2D[]): Point2D[] {
  if (points.length < 3) return points;

  const cleaned: Point2D[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const curr = points[i];
    const dx = Math.abs(curr[0] - prev[0]);
    const dy = Math.abs(curr[1] - prev[1]);
    if (dx > EPSILON || dy > EPSILON) {
      cleaned.push(curr);
    }
  }

  // Remove last point if it duplicates the first
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (
      Math.abs(first[0] - last[0]) < EPSILON &&
      Math.abs(first[1] - last[1]) < EPSILON
    ) {
      cleaned.pop();
    }
  }

  return cleaned;
}
