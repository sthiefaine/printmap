import type { BBox, OverpassResponse } from "@/types/osm";
import { fetchWithTimeout } from "./request";
import { LANDMARK_SELECTORS } from "./point-landmarks";

export function buildOverpassQuery(bbox: BBox, timeoutSeconds = 35) {
  const bb = bbox.join(",");
  return `[out:json][timeout:${timeoutSeconds}][maxsize:134217728];
    (
      wr["building"]["building"!="no"](${bb});
      wr["building:part"]["building:part"!="no"](${bb});
      way["highway"]["area"!="yes"](${bb});
      wr["highway"]["area"="yes"](${bb});
      wr["area:highway"](${bb});
      way["railway"~"^(rail|light_rail|tram|narrow_gauge|preserved)$"](${bb});
      wr["leisure"~"^(park|garden|golf_course|pitch|recreation_ground|nature_reserve)$"](${bb});
      wr["landuse"~"^(grass|meadow|forest|farmland|orchard|vineyard|recreation_ground|village_green)$"](${bb});
      wr["natural"~"^(wood|grassland|scrub|heath|wetland|water|beach|sand)$"](${bb});
      wr["waterway"~"^(riverbank|river|stream|canal|drain|ditch|dock)$"](${bb});
      wr["water"]["water"!="sea"](${bb});
      wr["leisure"="swimming_pool"](${bb});
      way["natural"="coastline"](${bb});
      wr["man_made"~"^(pier|dock|bridge|aqueduct|embankment)$"](${bb});
      wr["historic"~"^(city_gate|aqueduct|ruins|castle|fort)$"](${bb});
      ${LANDMARK_SELECTORS.map((selector) => `${selector}(${bb});`).join("\n      ")}
      way["barrier"~"^(wall|retaining_wall|city_wall)$"](${bb});
      wr["bridge"]["bridge"!="no"](${bb});
    ); out body geom;`;
}

export async function fetchOverpass(
  bbox: BBox,
  signal: AbortSignal,
): Promise<OverpassResponse> {
  const configured = process.env.OVERPASS_URL;
  const endpoints = configured
    ? [{ url: configured, method: "POST", timeoutMs: 38000 }]
    : [
        {
          url: "https://overpass-api.de/api/interpreter",
          method: "POST",
          timeoutMs: 24000,
        },
        {
          url: "https://overpass.private.coffee/api/interpreter",
          method: "POST",
          timeoutMs: 24000,
        },
        // Independent global mirror. GET is supported by Overpass and avoids
        // the POST gateway failure observed here on the full Expo selection.
        {
          url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
          method: "GET",
          timeoutMs: 32000,
        },
      ];
  for (const endpoint of endpoints) {
    signal.throwIfAborted();
    try {
      // All three attempts fit inside the route's 85 s acquisition deadline.
      // Stop remote execution before its corresponding client timeout, too.
      const query = new URLSearchParams({
        data: buildOverpassQuery(bbox, endpoint.timeoutMs / 1000 - 3),
      });
      const url = new URL(endpoint.url);
      if (endpoint.method === "GET")
        url.searchParams.set("data", query.get("data")!);
      const res = await fetchWithTimeout(
        url.toString(),
        {
          method: endpoint.method,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "PrintMap/3.0",
          },
          ...(endpoint.method === "POST" ? { body: query } : {}),
        },
        signal,
        endpoint.timeoutMs,
      );
      if (!res.ok) continue;
      const data: OverpassResponse = await res.json();
      // Overpass can return HTTP 200 with a runtime error and incomplete data.
      if (!Array.isArray(data.elements) || data.remark) continue;
      const vertices = data.elements.reduce(
        (count, element) =>
          count +
          (element.geometry?.length ?? 0) +
          (element.members?.reduce(
            (sum, member) => sum + (member.geometry?.length ?? 0),
            0,
          ) ?? 0),
        0,
      );
      if (data.elements.length > 70000 || vertices > 500000)
        throw new Error(
          "Zone trop dense : réduisez la sélection pour conserver tous les détails imprimables.",
        );
      return data;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith("Zone trop dense"))
        throw error;
    }
  }
  throw new Error(
    "Les serveurs OpenStreetMap ne répondent pas pour le moment. Votre sélection est conservée : réessayez dans quelques instants.",
  );
}
