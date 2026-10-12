import type { BBox, MapDataResponse } from "@/types/osm";
import { bboxDimensions, isMetropolitanFrance } from "./bbox";
import { fetchOverpass } from "./overpass";
import { fetchIGNBuildings, enrichWithIGN } from "./ign-buildings";
import { fetchElevation } from "./elevation";
import { fetchWaterPolygons } from "./ocean";
import { parseElements } from "@/lib/osm/parse-elements";
import { selectComplementaryWater } from "./water-coverage";
import { parseLengthMeters } from "@/lib/osm/building-height";
import { summarizePointLandmarks } from "./point-landmarks";
import { enrichIGNRoofs, fetchIGNRoofGrid } from "./ign-roofs";
import {
  fetchCRAIGBuildings,
  CRAIG_BUILDINGS_SOURCE,
  CRAIG_BUILDINGS_REFERENCE,
} from "./craig-buildings";
import {
  enrichWithMunicipalRoofs,
  fetchMontpellierRoofs,
  MONTPELLIER_LOD2_SOURCE,
} from "./montpellier-lod2";
import {
  enrichWithMunicipalStructures,
  fetchMontpellierStructures,
  MONTPELLIER_STRUCTURES_SOURCE,
} from "./montpellier-structures";

export async function collectMapData(
  bbox: BBox,
  relief: boolean,
  signal: AbortSignal,
): Promise<MapDataResponse> {
  const startedAt = Date.now();
  const results = await Promise.allSettled([
    fetchOverpass(bbox, signal),
    isMetropolitanFrance(bbox)
      ? fetchIGNBuildings(bbox, signal)
      : Promise.resolve({ features: [], warnings: [] }),
    relief ? fetchElevation(bbox, signal) : Promise.resolve(null),
    fetchWaterPolygons(bbox, signal),
    fetchMontpellierRoofs(bbox, signal),
    fetchMontpellierStructures(bbox, signal),
    fetchCRAIGBuildings(bbox, signal),
    isMetropolitanFrance(bbox)
      ? fetchIGNRoofGrid(bbox, signal)
      : Promise.resolve(null),
  ]);
  signal.throwIfAborted();
  const [
    osmResult,
    ignResult,
    elevationResult,
    oceanResult,
    municipalResult,
    structuresResult,
    craigResult,
    roofGridResult,
  ] = results;
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
  if (municipalResult.status === "fulfilled") {
    warnings.push(...municipalResult.value.warnings);
    if (municipalResult.value.buildings.length) {
      elements = enrichWithMunicipalRoofs(
        elements,
        municipalResult.value.buildings,
      ).elements;
      sources.push(
        `${MONTPELLIER_LOD2_SOURCE} · ODbL · https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier`,
      );
      warnings.push(
        "Toitures municipales mesurées en 2020 : les constructions plus récentes présentes dans OSM sont conservées lorsqu’elles ne correspondent pas au modèle municipal.",
      );
    }
  } else
    warnings.push(
      "Modèle municipal 3D indisponible ; utilisation des empreintes et toitures OSM.",
    );
  let municipalStructureCount = 0;
  if (craigResult.status === "fulfilled") {
    warnings.push(...craigResult.value.warnings);
    if (craigResult.value.buildings.length) {
      elements = enrichWithMunicipalRoofs(
        elements,
        craigResult.value.buildings,
        {
          source: CRAIG_BUILDINGS_SOURCE,
          prefix: "CRAIG/2021",
          heightSource: "CRAIG · géométrie LoD2.2 mesurée",
          year: 2021,
        },
      ).elements;
      sources.push(
        `${CRAIG_BUILDINGS_SOURCE} · Licence Ouverte 2.0 · ${CRAIG_BUILDINGS_REFERENCE}`,
      );
    }
  }
  if (structuresResult.status === "fulfilled") {
    warnings.push(...structuresResult.value.warnings);
    if (structuresResult.value.elements.length) {
      const enriched = enrichWithMunicipalStructures(
        elements,
        structuresResult.value.elements,
      );
      elements = enriched.elements;
      municipalStructureCount = enriched.count;
      sources.push(
        `${MONTPELLIER_STRUCTURES_SOURCE} · https://data.montpellier3m.fr/dataset/ouvrages-dart-de-montpellier-mediterranee-metropole`,
      );
      if (
        structuresResult.value.elements.some(
          (e) => e.tags?.["printmap:structure_type"] === "aqueduct",
        )
      )
        warnings.push(
          "L’aqueduc est localisé par l’inventaire municipal ; cette source ne fournit pas la géométrie de ses voûtes et piles.",
        );
      if (
        elements.some(
          (element) => element.tags?.["printmap:bridge_deck_elevation"],
        )
      )
        sources.push(
          "IGN · BD TOPO (altitude de chaussée du Pont Vialleton, précision 1,5 m) · Licence Ouverte 2.0 · https://data.geopf.fr/annexes/ressources/documentation/DC_BDTOPO_3-5.pdf",
        );
    }
  }
  let lidarRoofBuildingCount = 0,
    lidarRoofSurfaceCount = 0,
    lidarRoofResolutionM: number | null = null;
  if (roofGridResult.status === "fulfilled" && roofGridResult.value) {
    const reconstructed = await enrichIGNRoofs(elements, bbox, signal, {
      grid: roofGridResult.value,
      // Optional reconstruction must leave time for the mandatory response.
      cpuBudgetMs: Math.min(
        12000,
        Math.max(0, 80000 - (Date.now() - startedAt)),
      ),
    });
    elements = reconstructed.elements;
    lidarRoofBuildingCount = reconstructed.buildingCount;
    lidarRoofSurfaceCount = reconstructed.surfaceCount;
    lidarRoofResolutionM = reconstructed.resolutionM;
    warnings.push(...reconstructed.warnings);
    sources.push(...reconstructed.sources);
  } else if (isMetropolitanFrance(bbox))
    warnings.push(
      "Toitures LiDAR IGN indisponibles ; les géométries 3D existantes et les hauteurs habituelles sont conservées.",
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
  const pointLandmarks = summarizePointLandmarks(elements, bbox);
  warnings.push(...pointLandmarks.warnings);
  const buildings = parseElements(elements, bbox, 5000).buildings;
  const measuredBuildingCount = buildings.filter(
    (building) =>
      parseLengthMeters(building.tags.height) != null ||
      parseLengthMeters(building.tags["building:height"]) != null,
  ).length;
  const roofBuildings = [
    ...new Map(
      buildings
        .filter(
          (building) =>
            building.roofSurfaces?.length &&
            building.tags["printmap:roof_reconstruction"] !== "lidar",
        )
        .map((building) => [building.sourceId, building]),
    ).values(),
  ];
  const roofYears = [
    ...new Set(
      roofBuildings
        .map((building) =>
          Number(
            building.tags["printmap:roof_year"] ?? building.measuredSolid?.year,
          ),
        )
        .filter(Number.isInteger),
    ),
  ];
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
      lod2BuildingCount: buildings.filter(
        (building) =>
          building.roofSurfaces?.length &&
          building.tags["printmap:roof_reconstruction"] !== "lidar",
      ).length,
      lod2RoofSurfaceCount: roofBuildings.reduce(
        (sum, building) => sum + (building.roofSurfaces?.length ?? 0),
        0,
      ),
      lod2SolidCount: buildings.filter(
        (building) => building.measuredSolid?.surfaces.length,
      ).length,
      lidarRoofBuildingCount,
      lidarRoofSurfaceCount,
      lidarRoofResolutionM,
      municipalStructureCount,
      pointLandmarkCount: pointLandmarks.pointLandmarkCount,
      ...(roofYears.length === 1 ? { lod2Year: roofYears[0] } : {}),
    },
  };
}
