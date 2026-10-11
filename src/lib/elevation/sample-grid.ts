import type { ElevationGrid } from "@/types/osm";

/**
 * Bilinear interpolation on the elevation grid.
 * Returns elevation in meters at the given lat/lng.
 */
export function sampleElevation(
  grid: ElevationGrid,
  lat: number,
  lng: number,
): number {
  const { rows, cols, points, south, west, north, east } = grid;

  // Normalize to grid coordinates [0, rows-1] and [0, cols-1]
  const rowF = ((lat - south) / (north - south)) * (rows - 1);
  const colF = ((lng - west) / (east - west)) * (cols - 1);

  // Clamp
  const r = Math.max(0, Math.min(rows - 1, rowF));
  const c = Math.max(0, Math.min(cols - 1, colF));

  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  const r1 = Math.min(r0 + 1, rows - 1);
  const c1 = Math.min(c0 + 1, cols - 1);

  const fr = r - r0;
  const fc = c - c0;

  const e00 = points[r0 * cols + c0];
  const e01 = points[r0 * cols + c1];
  const e10 = points[r1 * cols + c0];
  const e11 = points[r1 * cols + c1];

  // Bilinear interpolation
  return (
    e00 * (1 - fr) * (1 - fc) +
    e01 * (1 - fr) * fc +
    e10 * fr * (1 - fc) +
    e11 * fr * fc
  );
}

/**
 * Sample elevation at a projected x/z coordinate.
 * Converts back to lat/lng using the bbox and scale factor, then samples.
 */
export function sampleElevationAtXZ(
  grid: ElevationGrid,
  x: number,
  z: number,
  centerLat: number,
  centerLng: number,
  sf: number,
): number {
  const EARTH_RADIUS = 6371000;
  const metersPerDegreeLat = (Math.PI / 180) * EARTH_RADIUS;
  const metersPerDegreeLng =
    (Math.PI / 180) * EARTH_RADIUS * Math.cos(centerLat * (Math.PI / 180));

  // x/z are in scaled units → convert to meters → convert to degrees
  const metersX = x / sf;
  const metersZ = z / sf;

  const lng = metersX / metersPerDegreeLng + centerLng;
  const lat = metersZ / metersPerDegreeLat + centerLat;

  return sampleElevation(grid, lat, lng);
}
