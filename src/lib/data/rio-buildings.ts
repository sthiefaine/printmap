import type { BBox } from "@/types/osm";
import type { IGNBuildings, IGNFeature } from "./ign-buildings";
import { bboxDimensions } from "./bbox";
import { fetchWithTimeout } from "./request";

export const RIO_BUILDINGS_URL =
  "https://pgeo3.rio.rj.gov.br/arcgis/rest/services/CadLog/Edificacoes_2019/MapServer/0/query";
export const RIO_BUILDINGS_SOURCE =
  "Prefeitura do Rio de Janeiro · Instituto Pereira Passos · Edificações 2019 · contours et hauteurs LoD1 · https://pgeo3.rio.rj.gov.br/arcgis/rest/services/CadLog/Edificacoes_2019/MapServer/0";

export async function fetchRioBuildings(
  bbox: BBox,
  signal: AbortSignal,
): Promise<IGNBuildings> {
  const result: IGNBuildings = { features: [], warnings: [] };
  if (bbox[0] < -23.1 || bbox[2] > -22.7 || bbox[1] < -43.8 || bbox[3] > -43)
    return result;
  if (bboxDimensions(bbox).areaKm2 > 4) {
    result.warnings.push(
      "Les contours et hauteurs municipaux de Rio sont acquis sur les sélections de 4 km² maximum. Le cadrage « Copacabana · architecture » permet d’en conserver davantage à l’impression.",
    );
    return result;
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(18000)]);
  const seen = new Set<number>();
  let vertices = 0,
    rejected = 0,
    offset = 0;
  try {
    for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
      deadline.throwIfAborted();
      const url = new URL(RIO_BUILDINGS_URL);
      for (const [key, value] of Object.entries({
        f: "geojson",
        where: "tipo LIKE 'A10%' AND altura > 0 AND altura < 300",
        geometry: `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        returnGeometry: "true",
        returnZ: "false",
        outFields: "objectid,altura,base,topo",
        orderByFields: "objectid ASC",
        resultOffset: String(offset),
        resultRecordCount: "1000",
      }))
        url.searchParams.set(key, value);
      const response = await fetchWithTimeout(
        url.toString(),
        {},
        deadline,
        10000,
      );
      if (!response.ok) throw new Error("Contours municipaux indisponibles.");
      const page = await response.json();
      if (
        !Array.isArray(page.features) ||
        page.features.length > 1000 ||
        page.error
      )
        throw new Error("Réponse municipale invalide.");
      for (const feature of page.features) {
        const { objectid, altura, base, topo } = feature.properties ?? {};
        if (!Number.isSafeInteger(objectid) || seen.has(objectid)) continue;
        seen.add(objectid);
        // Attributes are the published LoD1 heights. Native geometry Z differs
        // from these attributes in live data; never reinterpret it as a roof.
        if (
          ![altura, base, topo].every(Number.isFinite) ||
          altura <= 0 ||
          altura >= 300 ||
          Math.abs(topo - base - altura) > 0.2
        ) {
          rejected++;
          continue;
        }
        const geometry = feature.geometry as IGNFeature["geometry"];
        if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
          rejected++;
          continue;
        }
        const polygons =
          geometry.type === "Polygon"
            ? [geometry.coordinates as number[][][]]
            : (geometry.coordinates as number[][][][]);
        const points = polygons.flat(2);
        if (
          !points.length ||
          points.some(
            (p) =>
              !Array.isArray(p) ||
              p.length < 2 ||
              !Number.isFinite(p[0]) ||
              !Number.isFinite(p[1]) ||
              p[0] < -43.8 ||
              p[0] > -43 ||
              p[1] < -23.1 ||
              p[1] > -22.7,
          )
        ) {
          rejected++;
          continue;
        }
        vertices += points.length;
        if (vertices > 180000)
          throw new Error("Budget de contours municipaux atteint.");
        result.features.push({
          id: `RIO/IPP/2019/${objectid}`,
          geometry,
          properties: { hauteur: altura },
        });
      }
      if (page.features.length < 1000 && !page.exceededTransferLimit) break;
      if (!page.features.length)
        throw new Error("La pagination municipale n’avance plus.");
      // ArcGIS offsets count returned records, not requested page capacity.
      // A short transfer-limited page must not skip the following contours.
      offset += page.features.length;
      if (pageIndex === 5)
        result.warnings.push(
          "La collecte municipale de Rio est limitée à six pages, soit 6 000 contours maximum. Les autres bâtiments OSM restent disponibles.",
        );
    }
  } catch {
    signal.throwIfAborted();
    result.warnings.push(
      "Contours municipaux de Rio partiellement ou momentanément indisponibles ; les bâtiments OpenStreetMap restent disponibles.",
    );
  }
  if (rejected)
    result.warnings.push(
      `${rejected} contour(s) municipaux sans géométrie ou hauteur cohérente n’ont pas été ajoutés.`,
    );
  return result;
}
