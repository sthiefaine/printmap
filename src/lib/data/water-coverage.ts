import type { BBox, LatLon, OverpassElement } from "@/types/osm";
import {
  elementPolygons,
  geographicPointInRing,
  type GeographicPolygon,
} from "@/lib/osm/relation-polygons";

const contains = (polygon: GeographicPolygon, point: LatLon) =>
  geographicPointInRing(point, polygon.outer) &&
  !polygon.holes.some((hole) => geographicPointInRing(point, hole));

/** Fill only completely missing water areas. Preserve the more detailed OSM shores and islands. */
export function selectComplementaryWater(
  elements: OverpassElement[],
  tiledWater: OverpassElement[],
  bbox: BBox,
): OverpassElement[] {
  const ways = new Map(
    elements
      .filter((element) => element.type === "way")
      .map((element) => [element.id, element]),
  );
  const existing = elements
    .filter(
      (element) =>
        element.tags?.natural === "water" ||
        element.tags?.waterway === "riverbank" ||
        !!element.tags?.water,
    )
    .flatMap((element) => elementPolygons(element, ways));
  return tiledWater.filter((element) => {
    if (element.tags?.natural === "sea") return true;
    const polygon = elementPolygons(element)[0];
    if (!polygon) return false;
    const lat = polygon.outer.map((p) => p.lat),
      lon = polygon.outer.map((p) => p.lon);
    const south = Math.max(bbox[0], Math.min(...lat)),
      north = Math.min(bbox[2], Math.max(...lat));
    const west = Math.max(bbox[1], Math.min(...lon)),
      east = Math.min(bbox[3], Math.max(...lon));
    if (south >= north || west >= east) return false;
    const samples: LatLon[] = [];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        const point = {
          lat: south + ((r + 0.5) / 7) * (north - south),
          lon: west + ((c + 0.5) / 7) * (east - west),
        };
        if (contains(polygon, point)) samples.push(point);
      }
    // Even partial existing coverage keeps OSM as the sole source for that area;
    // a generalised tile must not cover an accurately mapped small island.
    if (
      samples.some((point) =>
        existing.some((area) => geographicPointInRing(point, area.outer)),
      )
    )
      return false;
    // Also test OSM shore vertices for tiny ponds not hit by the sample grid.
    if (
      existing.some((area) =>
        [area.outer, ...area.holes].some((ring) =>
          ring.some(
            (point) =>
              point.lat >= south &&
              point.lat <= north &&
              point.lon >= west &&
              point.lon <= east &&
              contains(polygon, point),
          ),
        ),
      )
    )
      return false;
    return samples.length > 0;
  });
}
