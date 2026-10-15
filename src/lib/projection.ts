import type { BBox } from "@/types/osm";

const EARTH_RADIUS = 6371000; // meters

export function createLocalProjection(
  originLat: number,
  originLng: number,
  longitudeScaleLat = originLat,
) {
  const latRad = longitudeScaleLat * (Math.PI / 180);
  const metersPerDegreeLat = (Math.PI / 180) * EARTH_RADIUS;
  const metersPerDegreeLng = (Math.PI / 180) * EARTH_RADIUS * Math.cos(latRad);

  return {
    project(lng: number, lat: number): [number, number] {
      const x = (lng - originLng) * metersPerDegreeLng;
      const y = (lat - originLat) * metersPerDegreeLat;
      return [x, y];
    },
    unproject(x: number, y: number): [number, number] {
      const lng = x / metersPerDegreeLng + originLng;
      const lat = y / metersPerDegreeLat + originLat;
      return [lng, lat];
    },
  };
}

/** Keep the bbox centred while optionally sharing the assembly's X scale. */
export function createProjectionForBbox(bbox: BBox, originLat?: number) {
  const centerLat = (bbox[0] + bbox[2]) / 2;
  const centerLng = (bbox[1] + bbox[3]) / 2;
  return createLocalProjection(centerLat, centerLng, originLat ?? centerLat);
}
