import type { Ring } from "@/types/geometry";

export function pointInPolygon(tx: number, ty: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi > ty !== yj > ty && tx < ((xj - xi) * (ty - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
