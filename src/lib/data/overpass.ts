import type { BBox, OverpassResponse } from "@/types/osm";
import { abortableDelay, fetchWithTimeout } from "./request";

export function buildOverpassQuery(bbox: BBox, timeoutSeconds = 25) {
  const bb = bbox.join(",");
  return `[out:json][timeout:${timeoutSeconds}][maxsize:134217728];
    (
      wr["building"]["building"!="no"](${bb});
      wr["building:part"]["building:part"!="no"](${bb});
      way["highway"](${bb});
      wr["area:highway"](${bb});
      way["railway"~"^(rail|light_rail|narrow_gauge)$"](${bb});
      wr["leisure"~"^(park|garden|golf_course|pitch|recreation_ground|nature_reserve)$"](${bb});
      wr["landuse"~"^(grass|meadow|forest|orchard|vineyard|recreation_ground|village_green|cemetery)$"](${bb});
      wr["natural"~"^(wood|grassland|scrub|heath|wetland|water)$"](${bb});
      way["waterway"~"^(river|stream|canal)$"](${bb});
      wr["waterway"="riverbank"](${bb});
      wr["water"](${bb});
    ); out body geom;`;
}

const ENDPOINTS = [
  { url: "https://overpass-api.de/api/interpreter", method: "POST" },
  { url: "https://overpass.private.coffee/api/interpreter", method: "POST" },
  // Independent mirror; GET avoids a POST gateway failure seen on this host.
  {
    url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    method: "GET",
  },
];

async function query(
  endpoint: { url: string; method: string },
  bbox: BBox,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const body = new URLSearchParams({
    data: buildOverpassQuery(bbox, Math.round(timeoutMs / 1000) - 3),
  });
  const url = new URL(endpoint.url);
  if (endpoint.method === "GET")
    url.searchParams.set("data", body.get("data")!);
  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PrintMap/4.0",
      },
      ...(endpoint.method === "POST" ? { body } : {}),
    },
    signal,
    timeoutMs,
  );
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data: OverpassResponse = await res.json();
  // Overpass can return HTTP 200 with a runtime error and incomplete data.
  if (!Array.isArray(data.elements) || data.remark)
    throw new Error("Réponse Overpass incomplète");
  return data;
}

/** Public Overpass servers are often saturated. Ask the mirrors with a
 * staggered start and keep the first complete answer. */
export async function fetchOverpass(
  bbox: BBox,
  signal: AbortSignal,
): Promise<OverpassResponse> {
  const losers = new AbortController();
  const combined = AbortSignal.any([signal, losers.signal]);
  const configured = process.env.OVERPASS_URL;
  const attempts = configured
    ? [query({ url: configured, method: "POST" }, bbox, combined, 40000)]
    : ENDPOINTS.map((endpoint, index) =>
        abortableDelay(index * 4000, combined).then(() =>
          query(endpoint, bbox, combined, 40000),
        ),
      );
  try {
    return await Promise.any(attempts);
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Les serveurs OpenStreetMap ne répondent pas pour le moment. Réessayez dans quelques instants.",
    );
  } finally {
    losers.abort();
    // Late rejections of the cancelled attempts are expected.
    for (const attempt of attempts) attempt.catch(() => {});
  }
}
