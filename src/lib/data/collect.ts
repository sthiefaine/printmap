import type {
  BBox,
  MapData,
  OverpassElement,
  OverpassResponse,
} from "@/types/osm";
import { isMetropolitanFrance } from "./bbox";
import { abortableDelay } from "./request";
import { fetchOverpass } from "./overpass";
import { fetchIGNBuildings, enrichWithIGN } from "./ign-buildings";
import { fetchElevation } from "./elevation";
import { fetchVectorTiles } from "./vector-tiles";
import { selectComplementaryWater } from "./water-coverage";

/** How long the detailed Overpass extract may take before the vector tiles,
 * already downloaded by then, are used instead. */
const OVERPASS_PATIENCE_MS = 10000;

/** One Overpass query per zone, shared by every request for it and left
 * running when a request settles for tiles: the app asks again for the
 * detailed data, and must not start that slow query from scratch. */
const overpassQueries = new Map<string, Promise<OverpassResponse>>();
function sharedOverpass(bbox: BBox) {
  const key = bbox.join(",");
  let query = overpassQueries.get(key);
  if (!query) {
    query = fetchOverpass(bbox, AbortSignal.timeout(60000));
    overpassQueries.set(key, query);
    const current = query;
    const forget = (afterMs: number) =>
      setTimeout(() => {
        if (overpassQueries.get(key) === current) overpassQueries.delete(key);
      }, afterMs).unref?.();
    current.then(
      () => forget(120000),
      () => forget(0),
    );
  }
  return query;
}

/** OpenStreetMap comes from Overpass when it answers quickly, otherwise from
 * vector tiles of the same data. Heights, relief and sea are bonuses with
 * short deadlines: a slow service never blocks or fails the model. */
export async function collectMapData(
  bbox: BBox,
  signal: AbortSignal,
  /** Wait for Overpass as long as it takes instead of settling for tiles. */
  insistOnDetail = false,
): Promise<MapData> {
  const optional = (ms: number) =>
    AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  const france = isMetropolitanFrance(bbox);
  const overpass = sharedOverpass(bbox).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const tilesPending = fetchVectorTiles(bbox, optional(10000)).catch(
    () => null,
  );
  const ignPending = france
    ? fetchIGNBuildings(bbox, optional(12000)).catch(() => null)
    : Promise.resolve(null);
  const elevationPending = fetchElevation(bbox, optional(15000)).catch(
    () => null,
  );

  const tiles = await tilesPending;
  signal.throwIfAborted();
  const aborted = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    }),
  );
  aborted.catch(() => {});
  const osm = await Promise.race([
    overpass,
    aborted,
    ...(tiles && !insistOnDetail
      ? [abortableDelay(OVERPASS_PATIENCE_MS, signal).then(() => null)]
      : []),
  ]);
  signal.throwIfAborted();

  const sources: string[] = [];
  const warnings: string[] = [];
  let elements: OverpassElement[];
  const detailed = !!osm && "value" in osm;
  if (osm && "value" in osm) {
    elements = osm.value.elements;
    sources.push("OpenStreetMap · Overpass (données détaillées)");
    if (tiles) {
      const extra = selectComplementaryWater(elements, tiles.water, bbox);
      if (extra.length) {
        elements = [...elements, ...extra];
        sources.push("OpenFreeMap (mer et grands plans d’eau)");
      }
    }
  } else if (tiles) {
    elements = tiles.all;
    sources.push(
      "OpenStreetMap · tuiles OpenFreeMap (serveur détaillé trop lent, contours à ~0,5 m)",
    );
  } else throw osm?.error ?? new Error("Données OpenStreetMap indisponibles.");

  const ign = await ignPending;
  if (ign?.features.length) {
    const enriched = enrichWithIGN(elements, ign.features);
    elements = enriched.elements;
    sources.push(
      `IGN BD TOPO (hauteurs de ${enriched.enriched + enriched.added} bâtiments)`,
    );
  } else if (france && (!ign || ign.warnings.length))
    // No building at all usually means a neighbouring country, not an outage.
    warnings.push(
      "Hauteurs IGN indisponibles : hauteurs OSM ou estimées selon le type de bâtiment.",
    );

  const grid = await elevationPending;
  if (grid?.source) sources.push(grid.source.split(" · http")[0]);
  else
    warnings.push(
      "Relief indisponible pour cette zone : socle plat uniquement.",
    );
  signal.throwIfAborted();

  return {
    bbox,
    elements,
    elevation: grid,
    sources,
    warnings,
    fetchedAt: new Date().toISOString(),
    detailed,
  };
}
