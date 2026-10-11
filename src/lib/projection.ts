import type { BBox } from "@/types/osm";

const EARTH_RADIUS = 6371000; // meters

export function createLocalProjection(originLat: number, originLng: number) {
  const latRad = originLat * (Math.PI / 180);
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

export function createProjectionForBbox(bbox: BBox) {
  const centerLat = (bbox[0] + bbox[2]) / 2;
  const centerLng = (bbox[1] + bbox[3]) / 2;
  return createLocalProjection(centerLat, centerLng);
}
