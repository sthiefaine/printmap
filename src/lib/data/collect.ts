import type { BBox, MapDataResponse } from "@/types/osm";
import { bboxDimensions, isMetropolitanFrance } from "./bbox";
import { fetchOverpass } from "./overpass";
import { fetchIGNBuildings, enrichWithIGN } from "./ign-buildings";
import { fetchElevation } from "./elevation";
import { fetchWaterPolygons } from "./ocean";
import { parseElements } from "@/lib/osm/parse-elements";
import { selectComplementaryWater } from "./water-coverage";
import { parseLengthMeters } from "@/lib/osm/building-height";

export async function collectMapData(
  bbox: BBox,
  relief: boolean,
  signal: AbortSignal,
): Promise<MapDataResponse> {
  const results = await Promise.allSettled([
    fetchOverpass(bbox, signal),
    isMetropolitanFrance(bbox)
      ? fetchIGNBuildings(bbox, signal)
      : Promise.resolve({ features: [], warnings: [] }),
    relief ? fetchElevation(bbox, signal) : Promise.resolve(null),
    fetchWaterPolygons(bbox, signal),
  ]);
  signal.throwIfAborted();
  const [osmResult, ignResult, elevationResult, oceanResult] = results;
  if (osmResult.status === "rejected") throw osmResult.reason;
  const osm = osmResult.value;
  const warnings: string[] = [],
    sources = ["OpenStreetMap · Overpass"];
  let elements = osm.elements,
    ignBuildingCount = 0;
  if (ignResult.status === "fulfilled") {
    warnings.push(...ignResult.value.warnings);
    if (ignResult.value.features.length) {
      const enriched = enrichWithIGN(elements, ignResult.value.features);
      elements = enriched.elements;
      ignBuildingCount = enriched.added + enriched.enriched;
      sources.push("IGN · BD TOPO (empreintes et hauteurs à la gouttière)");
    }
  } else if (isMetropolitanFrance(bbox))
    warnings.push(
      "Enrichissement IGN indisponible ; hauteurs OSM ou estimées.",
    );
  const elevationGrid =
    elevationResult.status === "fulfilled" ? elevationResult.value : null;
  if (elevationGrid?.source) sources.push(elevationGrid.source);
  else if (relief)
    warnings.push(
      "Relief indisponible : la maquette est générée sur un socle plat.",
    );
  if (elevationGrid?.source?.includes("GLO-90"))
    warnings.push(
      "Relief mondial à 90 m de résolution : les petites variations du terrain ne sont pas représentées.",
    );
  warnings.push(...(elevationGrid?.warnings ?? []));
  if (oceanResult.status === "fulfilled") {
    const complementary = selectComplementaryWater(
      elements,
      oceanResult.value,
      bbox,
    );
    elements = [...elements, ...complementary];
    sources.push(
      "OpenFreeMap © OpenMapTiles · données OpenStreetMap (eau et mer)",
    );
    if (complementary.some((element) => element.tags?.natural === "sea"))
      warnings.push(
        "Les petits détails du trait de côte peuvent être simplifiés par la source cartographique.",
      );
    if (complementary.some((element) => element.tags?.natural === "water"))
      warnings.push(
        "Certains plans d’eau absents de l’extrait OSM sont complétés par la source cartographique ; leurs plus petits détails peuvent être simplifiés.",
      );
  } else
    warnings.push(
      "Couverture marine indisponible : les lacs et rivières OSM sont conservés, mais la mer n’est pas extrapolée depuis le trait de côte.",
    );
  const buildings = parseElements(elements, bbox, 5000).buildings;
  const measuredBuildingCount = buildings.filter(
    (building) =>
      parseLengthMeters(building.tags.height) != null ||
      parseLengthMeters(building.tags["building:height"]) != null,
  ).length;
  if (buildings.length > measuredBuildingCount)
    warnings.push(
      `${buildings.length - measuredBuildingCount} bâtiments sans hauteur mesurée : dimensions estimées à partir des étages ou du type de bâtiment.`,
    );
  if (
    buildings.some(
      (building) =>
        building.tags["roof:shape"] &&
        building.tags["roof:shape"] !== "flat" &&
        !building.tags["roof:height"],
    )
  )
    warnings.push(
      "Certaines formes de toiture sont renseignées sans hauteur : leur relief reste estimé.",
    );
  if (!elements.length)
    warnings.push(
      "Aucune donnée dans cette sélection. Essayez une zone voisine.",
    );
  return {
    osmData: { ...osm, elements },
    elevationGrid,
    report: {
      sources,
      warnings,
      fetchedAt: new Date().toISOString(),
      areaKm2: bboxDimensions(bbox).areaKm2,
      elementCount: elements.length,
      buildingCount: buildings.length,
      measuredBuildingCount,
      ignBuildingCount,
      elevationSource: elevationGrid?.source ?? null,
      elevationResolutionM: elevationGrid?.resolutionM ?? null,
      osmTimestamp: osm.osm3s?.timestamp_osm_base,
      seaCoverage:
        oceanResult.status === "fulfilled" ? "available" : "unavailable",
    },
  };
}
