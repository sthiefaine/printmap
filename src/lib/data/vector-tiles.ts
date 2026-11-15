import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { BBox, LatLon, OverpassElement } from "@/types/osm";
import { fetchWithTimeout } from "./request";

/** OpenFreeMap serves the OpenMapTiles schema, built from OpenStreetMap, from
 * a CDN: a few hundred milliseconds where Overpass can take half a minute.
 * At zoom 14 every building is present, snapped to roughly 0.5 m. */
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

const HIGHWAYS: Record<string, string> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  minor: "residential",
  busway: "busway",
  service: "service",
  track: "track",
  path: "footway",
};
const PATHS = [
  "pedestrian",
  "footway",
  "cycleway",
  "steps",
  "path",
  "bridleway",
];

export interface VectorTileData {
  /** Sea, lakes and rivers only: completes an Overpass extract. */
  water: OverpassElement[];
  /** Every layer, usable on its own when Overpass does not answer. */
  all: OverpassElement[];
}

export async function fetchVectorTiles(
  bbox: BBox,
  signal: AbortSignal,
): Promise<VectorTileData> {
  if (!metadata || metadata.expires < Date.now()) {
    const response = await fetchWithTimeout(
      "https://tiles.openfreemap.org/planet",
      {},
      signal,
      6000,
    );
    if (!response.ok) throw new Error("Tuiles vectorielles indisponibles");
    const template = (await response.json()).tiles?.[0];
    if (
      typeof template !== "string" ||
      !template.startsWith("https://tiles.openfreemap.org/")
    )
      throw new Error("Source de tuiles invalide");
    metadata = { template, expires: Date.now() + 60 * 60 * 1000 };
  }
  const minX = toTileX(bbox[1]),
    maxX = toTileX(bbox[3]),
    minY = toTileY(bbox[2]),
    maxY = toTileY(bbox[0]);
  if ((maxX - minX + 1) * (maxY - minY + 1) > 49)
    throw new Error("Zone trop grande pour les tuiles vectorielles");
  const tiles: { x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++) tiles.push({ x, y });

  const water: OverpassElement[] = [],
    others: OverpassElement[] = [];
  let id = -2000000000000;
  const ring = (points: number[][]): LatLon[] =>
    points.map(([lon, lat]) => ({ lon, lat }));
  const polygon = (
    rings: number[][][],
    tags: Record<string, string>,
  ): OverpassElement => ({
    type: "relation",
    id: id--,
    tags,
    members: rings.map((points, index) => ({
      type: "way",
      role: index ? "inner" : "outer",
      geometry: ring(points),
    })),
  });
  const line = (
    points: number[][],
    tags: Record<string, string>,
  ): OverpassElement => ({
    type: "way",
    id: id--,
    tags,
    geometry: ring(points),
  });

  for (let i = 0; i < tiles.length; i += 6) {
    const batch = await Promise.all(
      tiles.slice(i, i + 6).map(async ({ x, y }) => {
        const url = metadata!.template
          .replace("{z}", String(ZOOM))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
        const cached = tileCache.get(url);
        let bytes = cached && cached.expires > Date.now() ? cached.bytes : null;
        if (!bytes) {
          const response = await fetchWithTimeout(url, {}, signal, 6000);
          if (!response.ok) throw new Error("Tuile vectorielle indisponible");
          bytes = await response.arrayBuffer();
          if (tileCache.size >= 64)
            tileCache.delete(tileCache.keys().next().value!);
          tileCache.set(url, { bytes, expires: Date.now() + 60 * 60 * 1000 });
        }
        return { x, y, tile: new VectorTile(new PbfReader(bytes)) };
      }),
    );
    for (const { x, y, tile } of batch) {
      const each = (
        name: string,
        visit: (
          props: Record<string, unknown>,
          polygons: number[][][][],
          lines: number[][][],
        ) => void,
      ) => {
        const layer = tile.layers[name];
        for (let j = 0; j < (layer?.length ?? 0); j++) {
          const feature = layer.feature(j);
          const geometry = feature.toGeoJSON(x, y, ZOOM).geometry;
          visit(
            feature.properties,
            geometry.type === "Polygon"
              ? [geometry.coordinates]
              : geometry.type === "MultiPolygon"
                ? geometry.coordinates
                : [],
            geometry.type === "LineString"
              ? [geometry.coordinates]
              : geometry.type === "MultiLineString"
                ? geometry.coordinates
                : [],
          );
        }
      };
      each("water", (props, polygons) => {
        const kind = String(props.class);
        if (!["ocean", "lake", "river", "pond", "dock"].includes(kind)) return;
        const tags = {
          natural: kind === "ocean" ? "sea" : "water",
          water: kind,
        };
        for (const rings of polygons)
          (["ocean", "lake", "river"].includes(kind) ? water : others).push(
            polygon(rings, tags),
          );
      });
      each("building", (props, polygons) => {
        if (props.hide_3d) return;
        const tags: Record<string, string> = { building: "yes" };
        const height = Number(props.render_height);
        // 5 m is the schema's placeholder for "height unknown".
        if (height > 0 && height !== 5)
          tags["printmap:tile_height"] = String(height);
        for (const rings of polygons) others.push(polygon(rings, tags));
      });
      each("transportation", (props, polygons, lines) => {
        const kind = String(props.class),
          sub = String(props.subclass ?? "");
        const tunnel: Record<string, string> =
          props.brunnel === "tunnel" ? { tunnel: "yes" } : {};
        if (kind === "rail") {
          if (["rail", "light_rail", "narrow_gauge"].includes(sub))
            for (const points of lines)
              others.push(line(points, { railway: "rail", ...tunnel }));
          return;
        }
        const highway =
          kind === "path" && PATHS.includes(sub) ? sub : HIGHWAYS[kind];
        if (!highway) return;
        for (const points of lines)
          others.push(line(points, { highway, ...tunnel }));
        if (kind === "path" || kind === "minor")
          for (const rings of polygons)
            others.push(
              polygon(rings, { highway: "pedestrian", area: "yes", ...tunnel }),
            );
      });
      each("waterway", (props, _polygons, lines) => {
        const kind = String(props.class);
        if (!["river", "canal", "stream"].includes(kind)) return;
        if (props.brunnel === "tunnel") return;
        for (const points of lines)
          others.push(line(points, { waterway: kind }));
      });
      each("landcover", (props, polygons) => {
        const kind = String(props.class);
        const tags: Record<string, string> | null =
          kind === "grass"
            ? { landuse: "grass" }
            : kind === "wood"
              ? { natural: "wood" }
              : kind === "wetland"
                ? { natural: "wetland" }
                : null;
        if (tags)
          for (const rings of polygons) others.push(polygon(rings, tags));
      });
    }
  }
  return { water, all: [...water, ...others] };
}
