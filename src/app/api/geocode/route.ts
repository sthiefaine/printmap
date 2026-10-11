import { NextResponse } from "next/server";
import type { NominatimResult } from "@/types/osm";
import { abortableDelay, fetchWithTimeout } from "@/lib/data/request";

const cache = new Map<
  string,
  { results: NominatimResult[]; expires: number }
>();
let nextRequestAt = 0;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 3) return NextResponse.json([]);
  if (q.length > 160)
    return NextResponse.json(
      { error: "Recherche trop longue" },
      { status: 400 },
    );
  const key = q.toLocaleLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now())
    return NextResponse.json(cached.results);
  try {
    // Photon supports search-as-you-type. Public Nominatim forbids autocomplete.
    const now = Date.now(),
      wait = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + 400;
    if (wait > 3000)
      return NextResponse.json(
        { error: "Trop de recherches simultanées" },
        { status: 429 },
      );
    if (wait) await abortableDelay(wait, request.signal);
    const url = new URL(
      process.env.PHOTON_URL ?? "https://photon.komoot.io/api/",
    );
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "5");
    url.searchParams.set("lang", "fr");
    const response = await fetchWithTimeout(
      url.toString(),
      { headers: { "User-Agent": "PrintMap/3.0" } },
      request.signal,
      10000,
    );
    if (!response.ok) throw new Error("Recherche indisponible");
    const data = await response.json();
    const results: NominatimResult[] = (data.features ?? []).flatMap(
      (
        feature: {
          geometry?: { coordinates?: number[] };
          properties?: Record<string, unknown>;
        },
        index: number,
      ) => {
        const coordinates = feature.geometry?.coordinates,
          props = feature.properties;
        if (
          !coordinates ||
          !props ||
          !Number.isFinite(coordinates[0]) ||
          !Number.isFinite(coordinates[1])
        )
          return [];
        const [lon, lat] = coordinates;
        const displayName = [
          ...new Set(
            [props.name, props.city, props.state, props.country].filter(
              Boolean,
            ),
          ),
        ].join(", ");
        return [
          {
            place_id: Number(props.osm_id) || index,
            display_name: displayName,
            lat: String(lat),
            lon: String(lon),
            boundingbox: [
              String(lat - 0.01),
              String(lat + 0.01),
              String(lon - 0.01),
              String(lon + 0.01),
            ] as NominatimResult["boundingbox"],
          },
        ];
      },
    );
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { results, expires: Date.now() + 24 * 60 * 60 * 1000 });
    return NextResponse.json(results);
  } catch {
    return NextResponse.json(
      {
        error:
          "Recherche momentanément indisponible. La carte reste utilisable.",
      },
      { status: 502 },
    );
  }
}
