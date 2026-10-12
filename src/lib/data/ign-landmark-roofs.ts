import type { BBox, OverpassElement, RoofSurface } from "@/types/osm";
import { elementPolygons } from "@/lib/osm/relation-polygons";
import {
  fetchIGNRoofGrid,
  IGN_ROOF_SOURCE,
  reconstructIGNRoof,
  type IGNRoofEnrichment,
  type IGNRoofGrid,
} from "./ign-roofs";
import { SAINT_ETIENNE_LANDMARKS } from "./saint-etienne-landmarks";
import { MAX_ROOF_BUILDINGS, MAX_ROOF_VERTICES } from "./validate-roofs";

const REFINED_IDS = new Set(["way/63322493", "way/63262968"]);
const catalog = new Map<string, string>(
  SAINT_ETIENNE_LANDMARKS.filter((entry) => REFINED_IDS.has(entry.id)).map(
    (entry) => [entry.id, entry.name],
  ),
);
const keyOf = (element: OverpassElement) => `${element.type}/${element.id}`;
const vertexCount = (surfaces: RoofSurface[]) =>
  surfaces.reduce(
    (sum, surface) =>
      sum +
      surface.outer.length +
      surface.holes.reduce((count, ring) => count + ring.length, 0),
    0,
  );

export interface IGNLandmarkRoofGrids {
  grids: Map<string, IGNRoofGrid>;
  warnings: string[];
}

/** Keep original raster samples without averaging or inventing intermediate Z.
 * Shift the bounds so every decimated cell centre stays exactly at its source
 * sample's Lambert-93 position, including grids with an odd number of cells. */
export function decimateIGNRoofGrid(
  grid: IGNRoofGrid,
  factor = 2,
): IGNRoofGrid {
  if (!Number.isInteger(factor) || factor < 1 || factor > 4)
    throw new Error("Décimation de toiture invalide.");
  const resolutionM = grid.resolutionM * factor;
  const cols = Math.ceil(grid.cols / factor),
    rows = Math.ceil(grid.rows / factor);
  const west = grid.west + (grid.resolutionM - resolutionM) / 2,
    north = grid.north - (grid.resolutionM - resolutionM) / 2;
  const sample = (values: Float32Array) =>
    Float32Array.from(
      { length: cols * rows },
      (_, index) =>
        values[
          Math.floor(index / cols) * factor * grid.cols +
            (index % cols) * factor
        ],
    );
  return {
    west,
    north,
    east: west + cols * resolutionM,
    south: north - rows * resolutionM,
    cols,
    rows,
    resolutionM,
    mns: sample(grid.mns),
    mnt: sample(grid.mnt),
  };
}

function candidates(elements: OverpassElement[], bbox: BBox) {
  const ways = new Map(
    elements.filter((element) => element.type === "way").map((e) => [e.id, e]),
  );
  const seen = new Set<string>();
  const selected = elements.filter((element) => {
    if (
      !catalog.has(keyOf(element)) ||
      element.roofSurfaces?.length ||
      element.measuredSolid ||
      !element.tags?.building ||
      element.tags.building === "no" ||
      element.tags.location === "underground" ||
      Number(element.tags.layer) < 0
    )
      return false;
    const covered = elementPolygons(element, ways).some((polygon) =>
      polygon.outer.some(
        (point) =>
          point.lat >= bbox[0] &&
          point.lat <= bbox[2] &&
          point.lon >= bbox[1] &&
          point.lon <= bbox[3],
      ),
    );
    const key = keyOf(element);
    if (!covered || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { selected, ways };
}

/** Start after OSM arrives, in parallel with the remaining providers. Two proven
 * catalogue identities only; retain all existing measured geometry. */
export async function fetchIGNLandmarkRoofGrids(
  elements: OverpassElement[],
  bbox: BBox,
  signal: AbortSignal,
): Promise<IGNLandmarkRoofGrids> {
  signal.throwIfAborted();
  const { selected, ways } = candidates(elements, bbox);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  const result: IGNLandmarkRoofGrids = { grids: new Map(), warnings: [] };
  await Promise.all(
    selected.map(async (element) => {
      const points = elementPolygons(element, ways).flatMap((polygon) => [
        ...polygon.outer,
        ...polygon.holes.flat(),
      ]);
      const localBbox: BBox = [
        Math.min(...points.map((p) => p.lat)) - 0.00004,
        Math.min(...points.map((p) => p.lon)) - 0.00004,
        Math.max(...points.map((p) => p.lat)) + 0.00004,
        Math.max(...points.map((p) => p.lon)) + 0.00004,
      ];
      try {
        const grid = await fetchIGNRoofGrid(localBbox, deadline);
        if (grid.resolutionM !== 0.5)
          throw new Error("La grille locale n’est pas native.");
        result.grids.set(keyOf(element), grid);
      } catch {
        signal.throwIfAborted();
        result.warnings.push(
          `${catalog.get(keyOf(element))} : surface LiDAR locale momentanément indisponible ; les données précédentes sont conservées.`,
        );
      }
    }),
  );
  signal.throwIfAborted();
  return result;
}

/** Reserve the returned triangle count before ordinary LiDAR reconstruction:
 * enrichIGNRoofs(..., {maxTriangles: 60000 - refined.triangleCount}). */
export async function enrichIGNLandmarkRoofs(
  elements: OverpassElement[],
  bbox: BBox,
  signal: AbortSignal,
  options: { grids?: Map<string, IGNRoofGrid>; cpuBudgetMs?: number } = {},
): Promise<IGNRoofEnrichment> {
  signal.throwIfAborted();
  const result: IGNRoofEnrichment = {
    elements,
    buildingCount: 0,
    surfaceCount: 0,
    triangleCount: 0,
    resolutionM: null,
    sources: [],
    warnings: [],
  };
  const { selected, ways } = candidates(elements, bbox);
  if (!selected.length) return result;
  const cpuBudgetMs = Math.max(0, Math.min(4000, options.cpuBudgetMs ?? 4000));
  if (!cpuBudgetMs) {
    result.warnings.push(
      "Toitures des repères non affinées dans le temps CPU disponible ; les données précédentes sont conservées.",
    );
    return result;
  }
  const acquisition = options.grids
    ? { grids: options.grids, warnings: [] }
    : await fetchIGNLandmarkRoofGrids(elements, bbox, signal);
  result.warnings.push(...acquisition.warnings);
  const stop = Date.now() + cpuBudgetMs;
  let importVertices = 0,
    importBuildings = 0;
  for (const element of elements) {
    if (element.roofSurfaces == null && element.measuredSolid == null) continue;
    importBuildings++;
    importVertices +=
      vertexCount(element.roofSurfaces ?? []) +
      vertexCount(element.measuredSolid?.surfaces ?? []);
  }
  const enriched = new Map<OverpassElement, OverpassElement>();
  for (const element of selected) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (Date.now() >= stop) {
      result.warnings.push(
        "Affinement LiDAR des repères interrompu à la limite du temps CPU disponible ; les données précédentes sont conservées.",
      );
      break;
    }
    const native = acquisition.grids.get(keyOf(element));
    if (!native) continue;
    if (native.resolutionM !== 0.5) {
      result.warnings.push(
        `${catalog.get(keyOf(element))} : le relevé local au pas natif de 0,5 m est absent ; les données précédentes sont conservées.`,
      );
      continue;
    }
    const grid = decimateIGNRoofGrid(native);
    const roof = reconstructIGNRoof(
      element,
      grid,
      ways,
      () => Date.now() < stop && !signal.aborted,
      { landmark: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (Date.now() >= stop) {
      result.warnings.push(
        "Affinement LiDAR des repères interrompu à la limite du temps CPU disponible ; les données précédentes sont conservées.",
      );
      break;
    }
    if (!roof) {
      result.warnings.push(
        `${catalog.get(keyOf(element))} : la surface LiDAR locale ne satisfait pas les contrôles de reconstruction ; les données précédentes sont conservées.`,
      );
      continue;
    }
    const vertices = vertexCount(roof.surfaces);
    if (
      result.triangleCount + roof.triangleCount > 8192 ||
      importVertices + vertices > MAX_ROOF_VERTICES ||
      importBuildings + 1 > MAX_ROOF_BUILDINGS
    ) {
      result.warnings.push(
        `${catalog.get(keyOf(element))} : affinement LiDAR non ajouté pour respecter les budgets de géométrie et d’import du projet ; les données précédentes sont conservées.`,
      );
      continue;
    }
    enriched.set(element, {
      ...element,
      roofSurfaces: roof.surfaces,
      groundElevation: roof.groundElevation,
      roofSource: IGN_ROOF_SOURCE,
      tags: {
        ...element.tags,
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_refinement": "landmark",
        "printmap:roof_resolution_m": String(grid.resolutionM),
        "printmap:roof_fit_tolerance_m": String(0.35 + grid.resolutionM * 0.12),
        "printmap:height_source":
          "IGN LiDAR HD · surface de toiture reconstruite",
        height: String(
          Math.round((roof.maxElevation - roof.groundElevation) * 100) / 100,
        ),
      },
    });
    importVertices += vertices;
    importBuildings++;
    result.buildingCount++;
    result.surfaceCount += roof.surfaces.length;
    result.triangleCount += roof.triangleCount;
    result.resolutionM = grid.resolutionM;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
  result.elements = elements.map((element) => enriched.get(element) ?? element);
  if (result.buildingCount) {
    result.sources.push(IGN_ROOF_SOURCE);
    result.warnings.push(
      `${result.buildingCount} repère(s) affinés depuis le LiDAR IGN : source au pas de 0,5 m, grille utilisée 1 m sans lissage. Les toitures sont reconstruites ; les façades et parties masquées ne sont pas relevées.`,
    );
  }
  return result;
}
