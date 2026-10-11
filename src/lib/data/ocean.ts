import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { BBox, OverpassElement } from "@/types/osm";
import { fetchWithTimeout } from "./request";

const ZOOM = 14;
let metadata: { template: string; expires: number } | null = null;
const tileCache = new Map<string, { bytes: ArrayBuffer; expires: number }>();
const toTileX = (lon: number) =>
  Math.min(
    2 ** ZOOM - 1,
    Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** ZOOM)),
  );
const toTileY = (lat: number) =>
  Math.floor(
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) *
      2 ** ZOOM,
  );

export async function fetchWaterPolygons(
  bbox: BBox,
  signal: AbortSignal,
): Promise<OverpassElement[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(18000)]);
  if (!metadata || metadata.expires < Date.now()) {
    const response = await fetchWithTimeout(
      "https://tiles.openfreemap.org/planet",
      {},
      deadline,
      8000,
    );
    if (!response.ok) throw new Error("Fond marin indisponible");
    const data = await response.json();
    const template = data.tiles?.[0];
    if (
      typeof template !== "string" ||
      !template.startsWith("https://tiles.openfreemap.org/")
    )
      throw new Error("Source marine invalide");
    metadata = { template, expires: Date.now() + 60 * 60 * 1000 };
  }
  const minX = toTileX(bbox[1]),
    maxX = toTileX(bbox[3]),
    minY = toTileY(bbox[2]),
    maxY = toTileY(bbox[0]);
  if ((maxX - minX + 1) * (maxY - minY + 1) > 36)
    throw new Error("Zone trop grande pour la couverture marine détaillée");
  const tiles: { x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++) tiles.push({ x, y });
  const elements: OverpassElement[] = [];
  let id = -2000000000000;
  for (let i = 0; i < tiles.length; i += 4) {
    const batch = await Promise.all(
      tiles.slice(i, i + 4).map(async ({ x, y }) => {
        const url = metadata!.template
          .replace("{z}", String(ZOOM))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
        const cached = tileCache.get(url);
        let bytes =
          cached?.expires && cached.expires > Date.now() ? cached.bytes : null;
        if (!bytes) {
          const response = await fetchWithTimeout(url, {}, deadline, 8000);
          if (!response.ok) throw new Error("Tuile marine indisponible");
          bytes = await response.arrayBuffer();
          if (bytes.byteLength > 3000000)
            throw new Error("Tuile marine trop volumineuse");
          if (tileCache.size >= 48)
            tileCache.delete(tileCache.keys().next().value!);
          tileCache.set(url, { bytes, expires: Date.now() + 60 * 60 * 1000 });
        }
        const water = new VectorTile(new PbfReader(bytes)).layers.water;
        const polygons: { rings: number[][][]; waterClass: string }[] = [];
        for (let j = 0; j < (water?.length ?? 0); j++) {
          const feature = water.feature(j);
          if (
            feature.type !== 3 ||
            !["ocean", "lake", "river"].includes(
              String(feature.properties.class),
            )
          )
            continue;
          const geometry = feature.toGeoJSON(x, y, ZOOM).geometry;
          const waterClass = String(feature.properties.class);
          if (geometry.type === "Polygon")
            polygons.push({ rings: geometry.coordinates, waterClass });
          else if (geometry.type === "MultiPolygon")
            polygons.push(
              ...geometry.coordinates.map((rings) => ({ rings, waterClass })),
            );
        }
        return polygons;
      }),
    );
    for (const polygon of batch.flat()) {
      elements.push({
        type: "relation",
        id: id--,
        tags: {
          natural: polygon.waterClass === "ocean" ? "sea" : "water",
          water: polygon.waterClass,
          "printmap:source": "OpenFreeMap · OpenMapTiles · OSM",
        },
        members: polygon.rings.map((ring, index) => ({
          type: "way",
          role: index ? "inner" : "outer",
          geometry: ring.map(([lon, lat]) => ({ lon, lat })),
        })),
      });
    }
  }
  return elements;
}
