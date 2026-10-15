import earcut from "earcut";
import type { BBox, OverpassElement } from "@/types/osm";
import {
  elementPolygons,
  type GeographicPolygon,
} from "@/lib/osm/relation-polygons";
import { fetchWithTimeout } from "./request";
import { parseLengthMeters } from "@/lib/osm/building-height";

export interface IGNFeature {
  id: string;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
  properties: {
    cleabs?: string;
    hauteur?: number;
    nombre_d_etages?: number;
    etat_de_l_objet?: string;
  };
}

export interface IGNBuildings {
  features: IGNFeature[];
  warnings: string[];
}

export interface BuildingEnrichmentProvenance {
  source: string;
  heightSource: string;
  idStart: number;
  eaveHeight: boolean;
  /** Municipal LoD1 surveys can contain overlapping volumes at different heights.
   * Keep distinct source IDs and require a close OSM match before deduplicating. */
  preserveDistinctVolumes?: boolean;
}

export async function fetchIGNBuildings(
  bbox: BBox,
  signal: AbortSignal,
): Promise<IGNBuildings> {
  signal.throwIfAborted();
  const features: IGNFeature[] = [],
    warnings: string[] = [];
  const seen = new Set<string>();
  const limit = 20000,
    pageSize = 2500;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(22000)]);
  try {
    for (let start = 0; start < limit; start += pageSize) {
      deadline.throwIfAborted();
      const url = new URL("https://data.geopf.fr/wfs/ows");
      const [south, west, north, east] = bbox;
      for (const [key, value] of Object.entries({
        SERVICE: "WFS",
        VERSION: "2.0.0",
        REQUEST: "GetFeature",
        TYPENAMES: "BDTOPO_V3:batiment",
        SRSNAME: "urn:ogc:def:crs:OGC:1.3:CRS84",
        BBOX: `${west},${south},${east},${north},urn:ogc:def:crs:OGC:1.3:CRS84`,
        COUNT: String(pageSize),
        STARTINDEX: String(start),
        OUTPUTFORMAT: "application/json",
        SORTBY: "cleabs",
      }))
        url.searchParams.set(key, value);
      const response = await fetchWithTimeout(
        url.toString(),
        {},
        deadline,
        14000,
      );
      if (!response.ok) throw new Error("IGN WFS indisponible");
      const page = await response.json();
      if (!Array.isArray(page.features))
        throw new Error("Réponse IGN invalide");
      // Stable sorting and source IDs keep successive pages independent, even
      // when the provider updates its matched count during this collection.
      for (const feature of page.features.slice(0, pageSize) as IGNFeature[]) {
        if (
          feature.properties?.etat_de_l_objet === "Détruit" ||
          !feature.geometry
        )
          continue;
        const key = feature.properties?.cleabs ?? feature.id;
        if (seen.has(key)) continue;
        seen.add(key);
        features.push(feature);
      }
      if (
        page.features.length < pageSize ||
        (typeof page.numberMatched === "number" &&
          start + pageSize >= page.numberMatched)
      )
        break;
      if (start + pageSize >= limit)
        warnings.push(
          "Enrichissement IGN limité aux 20 000 premiers bâtiments ; les empreintes OSM restent complètes. Réduisez la zone pour enrichir toutes les hauteurs.",
        );
    }
  } catch {
    signal.throwIfAborted();
    warnings.push(
      features.length
        ? "Enrichissement IGN partiel : certaines hauteurs restent estimées."
        : "Hauteurs IGN indisponibles pour cette zone ; utilisation des données OSM et d’estimations signalées.",
    );
  }
  return { features, warnings };
}

function featurePolygons(feature: IGNFeature): GeographicPolygon[] {
  const polygons =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates as number[][][]]
      : (feature.geometry.coordinates as number[][][][]);
  return polygons
    .filter((poly) => poly[0]?.length >= 4)
    .map((poly) => ({
      outer: poly[0].map(([lon, lat]) => ({ lon, lat })),
      holes: poly
        .slice(1)
        .map((ring) => ring.map(([lon, lat]) => ({ lon, lat }))),
    }));
}

interface Footprint {
  bounds: BBox;
  triangles: Point[][];
  area: number;
  element: OverpassElement;
}

type Point = [number, number];

function side(a: Point, b: Point, p: Point) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function polygonArea(points: Point[]) {
  let area = 0;
  for (let i = 1; i + 1 < points.length; i++)
    area += side(points[0], points[i], points[i + 1]);
  return Math.abs(area) / 2;
}

/** Clip a triangle against another triangle; both coordinates share one origin. */
function triangleIntersectionArea(a: Point[], b: Point[]) {
  let clipped = a;
  const orientation = side(b[0], b[1], b[2]) >= 0 ? 1 : -1;
  for (let i = 0; i < 3 && clipped.length; i++) {
    const start = b[i],
      end = b[(i + 1) % 3];
    const next: Point[] = [];
    let previous = clipped.at(-1)!;
    let previousSide = side(start, end, previous) * orientation;
    for (const current of clipped) {
      const currentSide = side(start, end, current) * orientation;
      if (currentSide >= 0 !== previousSide >= 0) {
        const fraction = previousSide / (previousSide - currentSide);
        next.push([
          previous[0] + (current[0] - previous[0]) * fraction,
          previous[1] + (current[1] - previous[1]) * fraction,
        ]);
      }
      if (currentSide >= 0) next.push(current);
      previous = current;
      previousSide = currentSide;
    }
    clipped = next;
  }
  return polygonArea(clipped);
}

function footprint(
  polygon: GeographicPolygon,
  element: OverpassElement,
): Footprint {
  const lat = polygon.outer.map((p) => p.lat),
    lon = polygon.outer.map((p) => p.lon);
  const bounds: BBox = [
    Math.min(...lat),
    Math.min(...lon),
    Math.max(...lat),
    Math.max(...lon),
  ];
  const points: Point[] = [],
    holes: number[] = [];
  for (const [index, ring] of [polygon.outer, ...polygon.holes].entries()) {
    if (index) holes.push(points.length);
    // Local coordinates avoid cancellation at small footprints; intersection ratios
    // are invariant under the common longitude/latitude scale within this selection.
    points.push(
      ...ring.map((p): Point => [p.lon - bounds[1], p.lat - bounds[0]]),
    );
  }
  const indices = earcut(points.flat(), holes);
  const triangles: Point[][] = [];
  for (let i = 0; i < indices.length; i += 3)
    triangles.push([
      points[indices[i]],
      points[indices[i + 1]],
      points[indices[i + 2]],
    ]);
  return {
    bounds,
    triangles,
    area: triangles.reduce(
      (total, triangle) => total + polygonArea(triangle),
      0,
    ),
    element,
  };
}

function overlap(a: Footprint, b: Footprint) {
  const intersection =
    Math.max(
      0,
      Math.min(a.bounds[2], b.bounds[2]) - Math.max(a.bounds[0], b.bounds[0]),
    ) *
    Math.max(
      0,
      Math.min(a.bounds[3], b.bounds[3]) - Math.max(a.bounds[1], b.bounds[1]),
    );
  const areaA = (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]);
  const areaB = (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]);
  if (intersection < Math.min(areaA, areaB) * 0.45) return 0;
  if (!a.area || !b.area) return 0;
  const offsetX = b.bounds[1] - a.bounds[1],
    offsetY = b.bounds[0] - a.bounds[0];
  const bTriangles = b.triangles.map((triangle) =>
    triangle.map(([x, y]): Point => [x + offsetX, y + offsetY]),
  );
  let actualIntersection = 0;
  for (const triangleA of a.triangles)
    for (const triangleB of bTriangles)
      actualIntersection += triangleIntersectionArea(triangleA, triangleB);
  // A courtyard is empty space, even when both bounding-box centres lie inside it.
  // A slight survey offset or an adjacent shared boundary must not suppress a building.
  if (actualIntersection < Math.min(a.area, b.area) * 0.45) return 0;
  return Math.min(1, actualIntersection / Math.max(a.area, b.area));
}

function bucketKeys(bounds: BBox) {
  const keys: string[] = [];
  for (
    let y = Math.floor(bounds[0] * 1000);
    y <= Math.floor(bounds[2] * 1000);
    y++
  )
    for (
      let x = Math.floor(bounds[1] * 1000);
      x <= Math.floor(bounds[3] * 1000);
      x++
    )
      keys.push(`${x}/${y}`);
  return keys;
}

export function enrichWithIGN(
  elements: OverpassElement[],
  features: IGNFeature[],
  provenance: BuildingEnrichmentProvenance = {
    source: "IGN BD TOPO",
    heightSource: "IGN · hauteur à la gouttière",
    idStart: -1000000000000,
    eaveHeight: true,
  },
) {
  const output: OverpassElement[] = elements.map((el) => ({
    ...el,
    tags: el.tags ? { ...el.tags } : undefined,
  }));
  const ways = new Map(
    output.filter((el) => el.type === "way").map((el) => [el.id, el]),
  );
  const buckets = new Map<string, Footprint[]>();
  for (const el of output) {
    if (
      (!el.tags?.building || el.tags.building === "no") &&
      (!el.tags?.["building:part"] || el.tags["building:part"] === "no")
    )
      continue;
    for (const polygon of elementPolygons(el, ways)) {
      const item = footprint(polygon, el);
      for (const key of bucketKeys(item.bounds))
        buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }
  }
  let added = 0,
    enriched = 0,
    id = provenance.idStart;
  for (const feature of features) {
    const height = feature.properties.hauteur;
    const tags: Record<string, string> = {
      building: "yes",
      "roof:shape": "flat",
      "printmap:source": provenance.source,
      "printmap:source_id": feature.properties.cleabs ?? feature.id,
    };
    if (typeof height === "number" && height > 0 && height < 1000) {
      tags.height = String(height);
      tags["printmap:height_source"] = provenance.heightSource;
    } else if (
      feature.properties.nombre_d_etages &&
      feature.properties.nombre_d_etages > 0
    )
      tags["building:levels"] = String(feature.properties.nombre_d_etages);
    for (const polygon of featurePolygons(feature)) {
      const synthetic: OverpassElement = {
        type: "relation",
        id: id--,
        tags,
        members: [
          { type: "way", role: "outer", geometry: polygon.outer },
          ...polygon.holes.map((geometry) => ({
            type: "way",
            role: "inner",
            geometry,
          })),
        ],
      };
      const item = footprint(polygon, synthetic);
      const candidates = [
        ...new Set(
          bucketKeys(item.bounds).flatMap((key) => buckets.get(key) ?? []),
        ),
      ];
      const matches = candidates
        .map((candidate) => ({ candidate, score: overlap(item, candidate) }))
        .filter(({ candidate, score }) => {
          if (!provenance.preserveDistinctVolumes) return score > 0;
          if (score < 0.6) return false;
          const candidateTags = candidate.element.tags!;
          // A new municipal volume must not erase the next one merely because
          // their projected contours overlap. An actual repeated source ID can
          // still be deduplicated when its footprint closely agrees.
          return (
            candidateTags["printmap:source"] !== provenance.source ||
            candidateTags["printmap:source_id"] === tags["printmap:source_id"]
          );
        });
      const best = matches.sort((a, b) => b.score - a.score)[0];
      if (best) {
        // Do not duplicate buildings from a different source. Replace only uncertain heights,
        // and only when the footprints closely agree (different building parts stay independent).
        const osmTags = best.candidate.element.tags!;
        if (
          best.score >= 0.6 &&
          parseLengthMeters(osmTags.height) == null &&
          parseLengthMeters(osmTags["building:height"]) == null &&
          tags.height
        ) {
          const roofHeight = provenance.eaveHeight
            ? (parseLengthMeters(osmTags["roof:height"]) ?? 0)
            : 0;
          osmTags.height = String(Number(tags.height) + roofHeight);
          if (provenance.eaveHeight)
            osmTags["printmap:eave_height"] = tags.height;
          osmTags["printmap:height_source"] = tags["printmap:height_source"];
          enriched++;
        }
      } else {
        output.push(synthetic);
        added++;
        for (const key of bucketKeys(item.bounds))
          buckets.set(key, [...(buckets.get(key) ?? []), item]);
      }
    }
  }
  return { elements: output, added, enriched };
}
