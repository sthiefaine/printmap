import type { LatLon, OverpassElement } from "@/types/osm";
import profiles from "./bridge-deck-profiles.json";

/** Verified surface samples can improve an existing cached OSM bridge as well. */
export function verifiedBridgeDeckProfile(
  sourceId: string,
  elements: OverpassElement[],
): {
  points: Array<LatLon & { elevationM: number }>;
  source: string;
  requests: string[];
  carriedWayId: number;
} | null {
  const data = profiles.bridges.find((p) => sourceId === `way/${p.osmWayId}`);
  if (!data) return null;
  const element = elements.find(
    (p) => p.type === "way" && p.id === data.osmWayId,
  );
  const geometry = element?.geometry;
  if (element?.tags?.man_made !== "bridge" || !geometry?.length) return null;
  const bounds = [
    Math.min(...geometry.map((p) => p.lat)),
    Math.min(...geometry.map((p) => p.lon)),
    Math.max(...geometry.map((p) => p.lat)),
    Math.max(...geometry.map((p) => p.lon)),
  ];
  // Stable identity alone is insufficient when an old/future cache uses another
  // outline. A few metres of map revision are allowed; relocated IDs are not.
  if (bounds.some((value, i) => Math.abs(value - data.bounds[i]) > 0.00005))
    return null;
  return {
    points: data.profile.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      elevationM: p.elevationM,
    })),
    source: `${profiles.source} · ${profiles.verticalDatum} · extraction ${profiles.retrievedAt} · Licence Ouverte Etalab 2.0`,
    requests: profiles.requests,
    carriedWayId: data.carriedWayId,
  };
}
