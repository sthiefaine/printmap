import type { BBox, OverpassElement } from "@/types/osm";
import {
  elementPolygons,
  geographicPointInRing,
} from "@/lib/osm/relation-polygons";
import { fetchWithTimeout } from "./request";
import vialletonElevation from "./vialleton-ign-elevation.json" with { type: "json" };

export const MONTPELLIER_STRUCTURES_SOURCE =
  "Montpellier Méditerranée Métropole · ouvrages d’art · ODbL";
export const MONTPELLIER_STRUCTURES_URL =
  "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_OuvragesArt.json";
interface Feature {
  geometry: { type: string; coordinates: number[][][] | number[][][][] };
  properties: Record<string, unknown>;
}
let cache: { expires: number; features: Feature[] } | undefined;
const intersects = (a: BBox, b: BBox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function polygons(feature: Feature) {
  const coordinates =
    feature.geometry?.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry?.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];
  return (coordinates as number[][][][]).flatMap((polygon) => {
    if (!polygon.length || polygon.length > 100) return [];
    const rings = polygon.map((ring) =>
      ring.map((point) => ({ lon: point[0], lat: point[1] })),
    );
    if (
      rings.some(
        (ring) =>
          ring.length < 4 ||
          ring.length > 10000 ||
          ring.some(
            (p) =>
              !Number.isFinite(p.lat) ||
              !Number.isFinite(p.lon) ||
              p.lat < 43.3 ||
              p.lat > 44 ||
              p.lon < 3.3 ||
              p.lon > 4.3,
          ),
      )
    )
      return [];
    if (
      rings.some(
        (ring) =>
          ring[0].lat !== ring.at(-1)!.lat || ring[0].lon !== ring.at(-1)!.lon,
      )
    )
      return [];
    return [{ outer: rings[0], holes: rings.slice(1) }];
  });
}

const bounds = (ring: Array<{ lat: number; lon: number }>): BBox => [
  Math.min(...ring.map((p) => p.lat)),
  Math.min(...ring.map((p) => p.lon)),
  Math.max(...ring.map((p) => p.lat)),
  Math.max(...ring.map((p) => p.lon)),
];
const scalar = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(number) && number > 0 && number < 1000
    ? String(number)
    : null;
};

/** One surveyed match, independently checked against the adjacent 2020 Arc ground (51.28 m). */
function verifiedDeckTags(
  element: OverpassElement,
  source: OverpassElement,
): Record<string, string> {
  if (
    element.type !== "way" ||
    element.id !== vialletonElevation.osmWayId ||
    source.tags?.["printmap:source_id"] !==
      `MMM/ouvrages/pont/${vialletonElevation.municipalId}/${vialletonElevation.municipalFeatureId}`
  )
    return {};
  const feature = vialletonElevation.feature;
  const altitudes = feature.geometry.coordinates.map((point) => point[2]);
  if (
    feature.properties.nature !== "Pont" ||
    !altitudes.length ||
    altitudes.some((z) => !Number.isFinite(z) || z < -100 || z > 1000)
  )
    return {};
  const mean = altitudes.reduce((sum, z) => sum + z, 0) / altitudes.length;
  return {
    "printmap:bridge_deck_elevation": String(Math.round(mean * 10) / 10),
    "printmap:bridge_deck_uncertainty": String(
      feature.properties.precision_altimetrique,
    ),
    "printmap:bridge_deck_source": `IGN · BD TOPO · ${feature.properties.cleabs}`,
    "printmap:bridge_deck_source_url": vialletonElevation.source,
    "printmap:bridge_deck_source_modified":
      feature.properties.date_modification.slice(0, 10),
    "printmap:bridge_deck_vertical_datum": vialletonElevation.verticalDatum,
  };
}

/** Inventory polygons are buffered locations, never printable physical footprints. */
export function structureElements(
  features: Feature[],
  bbox: BBox,
): OverpassElement[] {
  return features.flatMap((feature, index) => {
    const p = feature.properties ?? {},
      type = String(p.typ ?? "");
    if (!["pont", "mur", "auvent"].includes(type)) return [];
    const isAqueduct = /aqueduc/i.test(String(p.nom ?? ""));
    const tags: Record<string, string> = {
      "printmap:source": MONTPELLIER_STRUCTURES_SOURCE,
      "printmap:source_id": `MMM/ouvrages/${type}/${String(p.identifian ?? "")}/${String(p.id_foa ?? index)}`,
      "printmap:geometry_precision":
        "localisation cartographique tamponnée ; emprise et profil 3D non fournis",
      "printmap:location_only": "yes",
      "printmap:structure_type": isAqueduct
        ? "aqueduct"
        : type === "pont"
          ? "bridge"
          : type === "mur"
            ? "wall"
            : "canopy",
      ...(p.nom ? { name: String(p.nom).slice(0, 300) } : {}),
    };
    const year = Number(p.annee_last);
    if (Number.isInteger(year) && year >= 1900 && year <= 2100)
      tags["printmap:source_year"] = String(year);
    if (p.structure)
      tags["printmap:bridge_profile"] = String(p.structure).slice(0, 300);
    if (/vo[uû]te/i.test(String(p.structure ?? "")))
      tags["bridge:structure"] = "arch";
    for (const [input, output] of [
      ["gabarits_v", "printmap:bridge_clearance"],
      ["ouverture", "printmap:bridge_span"],
      ["largeurs_c", "printmap:bridge_width"],
      ["longueur", "printmap:bridge_length"],
      ["hauteurmax", "printmap:structure_max_height"],
    ]) {
      const value = scalar(p[input]);
      if (value) tags[output] = value;
    }
    return polygons(feature)
      .filter((polygon) => intersects(bbox, bounds(polygon.outer)))
      .map((polygon, component) => ({
        type: "relation" as const,
        id: -4000000000000 - index * 100 - component,
        tags,
        members: [
          { type: "way", role: "outer", geometry: polygon.outer },
          ...polygon.holes.map((geometry) => ({
            type: "way",
            role: "inner",
            geometry,
          })),
        ],
      }));
  });
}

export async function fetchMontpellierStructures(
  bbox: BBox,
  signal: AbortSignal,
) {
  if (!intersects(bbox, [43.45, 3.6, 43.85, 4.1]))
    return { elements: [] as OverpassElement[], warnings: [] as string[] };
  try {
    if (!cache || cache.expires < Date.now()) {
      const response = await fetchWithTimeout(
        MONTPELLIER_STRUCTURES_URL,
        {},
        signal,
        12000,
      );
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > 12 * 1024 * 1024
      )
        throw new Error("Inventory unavailable");
      const text = await response.text();
      if (text.length > 12 * 1024 * 1024)
        throw new Error("Inventory too large");
      const data = JSON.parse(text);
      if (!Array.isArray(data.features) || data.features.length > 10000)
        throw new Error("Inventory invalid");
      cache = { expires: Date.now() + 3600000, features: data.features };
    }
    return {
      elements: structureElements(cache.features, bbox),
      warnings: [] as string[],
    };
  } catch {
    signal.throwIfAborted();
    return {
      elements: [] as OverpassElement[],
      warnings: [
        "Inventaire municipal des ouvrages indisponible ; les ponts et murs OSM restent disponibles.",
      ],
    };
  }
}

/** Enrich actual OSM geometry; preserve unmatched inventory as explicit location metadata. */
export function enrichWithMunicipalStructures(
  elements: OverpassElement[],
  inventory: OverpassElement[],
) {
  const ways = new Map(
    elements.filter((e) => e.type === "way").map((e) => [e.id, e]),
  );
  const added: OverpassElement[] = [];
  const replacements = new Map<OverpassElement, OverpassElement>();
  for (const source of inventory) {
    const polygon = elementPolygons(source, ways)[0];
    if (!polygon) continue;
    let matched = false;
    for (const element of elements) {
      const type = source.tags?.["printmap:structure_type"];
      if (
        !(
          type === "wall" &&
          ["wall", "retaining_wall", "city_wall"].includes(
            element.tags?.barrier ?? "",
          )
        ) &&
        !(type === "bridge" && element.tags?.man_made === "bridge") &&
        !(
          type === "aqueduct" &&
          (element.tags?.man_made === "aqueduct" ||
            element.tags?.historic === "aqueduct")
        )
      )
        continue;
      const points =
        element.geometry ??
        element.members?.flatMap((m) => m.geometry ?? []) ??
        [];
      const center = polygon.outer.slice(0, -1).reduce(
        (sum, p) => ({
          lat: sum.lat + p.lat / (polygon.outer.length - 1),
          lon: sum.lon + p.lon / (polygon.outer.length - 1),
        }),
        { lat: 0, lon: 0 },
      );
      const containsLocation =
        type === "bridge" &&
        elementPolygons(element, ways).some(
          (area) =>
            geographicPointInRing(center, area.outer) &&
            !area.holes.some((hole) => geographicPointInRing(center, hole)),
        );
      if (
        points.length < 2 ||
        (!containsLocation &&
          points.filter((p) => geographicPointInRing(p, polygon.outer)).length /
            points.length <
            0.65)
      )
        continue;
      matched = true;
      replacements.set(element, {
        ...element,
        tags: {
          ...element.tags,
          ...Object.fromEntries(
            Object.entries(source.tags ?? {}).filter(
              ([key]) =>
                key.startsWith("printmap:bridge_") ||
                key === "printmap:structure_max_height" ||
                key === "printmap:source_year",
            ),
          ),
          "printmap:structure_source": MONTPELLIER_STRUCTURES_SOURCE,
          ...verifiedDeckTags(element, source),
        },
      });
    }
    if (!matched) added.push(source);
  }
  return {
    elements: [
      ...elements.map((element) => replacements.get(element) ?? element),
      ...added,
    ],
    count: inventory.length,
  };
}
