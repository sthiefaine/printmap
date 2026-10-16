import type {
  BBox,
  LatLon,
  OverpassElement,
  RoofSurface,
  LandmarkRefinementProgress,
} from "@/types/osm";
import {
  elementPolygons,
  type GeographicPolygon,
} from "@/lib/osm/relation-polygons";
import {
  fetchIGNRoofGrid,
  IGN_ROOF_SOURCE,
  reconstructIGNRoof,
  planIGNRoofGrid,
  type IGNRoofEnrichment,
  type IGNRoofGrid,
} from "./ign-roofs";
import { SAINT_ETIENNE_LANDMARKS } from "./saint-etienne-landmarks";
import { buildingLandmark } from "./building-landmarks";
import { isMetropolitanFrance } from "./bbox";
import { parseLengthMeters } from "../osm/building-height";
import { MAX_ROOF_BUILDINGS, MAX_ROOF_VERTICES } from "./validate-roofs";

const REFINED_IDS = new Set(["way/63322493", "way/63262968"]);
const catalog = new Map<string, string>(
  SAINT_ETIENNE_LANDMARKS.filter((entry) => REFINED_IDS.has(entry.id)).map(
    (entry) => [entry.id, entry.name],
  ),
);
const keyOf = (element: OverpassElement) => `${element.type}/${element.id}`;
const MAX_LOCAL_VERTICES = 10000;
const nameOf = (element: OverpassElement) =>
  catalog.get(keyOf(element)) ??
  (element.tags?.name || element.tags?.official_name
    ? buildingLandmark({ sourceId: keyOf(element), tags: element.tags ?? {} })
        ?.name
    : undefined);
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

/** Clip to a unit rectangle before measuring area, avoiding cancellation from
 * absolute geographic coordinates. Concave rings can yield disconnected pieces;
 * the clipping boundary bridges cancel in the signed area. */
function clippedRingArea(ring: LatLon[], bbox: BBox): number {
  let points: [number, number][] = ring.map((point) => [
    (point.lon - bbox[1]) / (bbox[3] - bbox[1]),
    (point.lat - bbox[0]) / (bbox[2] - bbox[0]),
  ]);
  for (const [axis, limit, greater] of [
    [0, 0, true],
    [0, 1, false],
    [1, 0, true],
    [1, 1, false],
  ] as const) {
    if (!points.length) return 0;
    const clipped: [number, number][] = [];
    const distance = (point: [number, number]) =>
      greater ? point[axis] - limit : limit - point[axis];
    let previous = points.at(-1)!;
    let previousDistance = distance(previous);
    for (const current of points) {
      const currentDistance = distance(current);
      if (previousDistance >= 0 !== currentDistance >= 0) {
        const fraction =
          previousDistance / (previousDistance - currentDistance);
        clipped.push([
          previous[0] + fraction * (current[0] - previous[0]),
          previous[1] + fraction * (current[1] - previous[1]),
        ]);
      }
      if (currentDistance >= 0) clipped.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
    points = clipped;
  }
  return (
    Math.abs(
      points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0),
    ) / 2
  );
}

function intersectsSelection(polygon: GeographicPolygon, bbox: BBox): boolean {
  const materialArea = polygon.holes.reduce(
    (area, hole) => area - clippedRingArea(hole, bbox),
    clippedRingArea(polygon.outer, bbox),
  );
  // Boundary-only contact and a rectangle wholly inside a real courtyard do
  // not contain printable building material or justify a local acquisition.
  return materialArea > 1e-12;
}

/** Bound work before relation assembly or grid planning; a malformed source
 * landmark must not prevent the other local acquisition from being attempted. */
function localRefinementBbox(
  element: OverpassElement,
  ways: Map<number, OverpassElement>,
  bbox: BBox,
): BBox | null {
  try {
    let vertices = 0;
    if (element.type === "relation") {
      for (const member of element.members ?? []) {
        const geometry =
          member.geometry ??
          (member.ref == null ? undefined : ways.get(member.ref)?.geometry);
        vertices += geometry?.length ?? 0;
        if (vertices > MAX_LOCAL_VERTICES) return null;
      }
    } else if ((element.geometry?.length ?? 0) > MAX_LOCAL_VERTICES)
      return null;
    const polygons = elementPolygons(element, ways);
    let south = Infinity,
      west = Infinity,
      north = -Infinity,
      east = -Infinity;
    vertices = 0;
    for (const polygon of polygons)
      for (const ring of [polygon.outer, ...polygon.holes])
        for (const point of ring) {
          if (
            ++vertices > MAX_LOCAL_VERTICES ||
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lon)
          )
            return null;
          south = Math.min(south, point.lat);
          west = Math.min(west, point.lon);
          north = Math.max(north, point.lat);
          east = Math.max(east, point.lon);
        }
    if (!polygons.some((polygon) => intersectsSelection(polygon, bbox)))
      return null;
    const localBbox: BBox = [
      south - 0.00004,
      west - 0.00004,
      north + 0.00004,
      east + 0.00004,
    ];
    const plan = planIGNRoofGrid(localBbox);
    return plan.resolutionM === 0.5 && plan.cols * plan.rows <= 250000
      ? localBbox
      : null;
  } catch {
    return null;
  }
}

export function landmarkRefinementCandidates(
  elements: OverpassElement[],
  bbox: BBox,
  availableGrids?: ReadonlyMap<string, IGNRoofGrid>,
  options: { allowCoarseLidar?: boolean; skipIds?: ReadonlySet<string> } = {},
) {
  const ways = new Map(
    elements.filter((element) => element.type === "way").map((e) => [e.id, e]),
  );
  const localBounds = new Map<string, BBox>();
  if (!isMetropolitanFrance(bbox)) return { selected: [], ways, localBounds };
  const seen = new Set<string>();
  const selected = elements.filter((element) => {
    if (
      !nameOf(element) ||
      (element.roofSurfaces?.length &&
        !(
          options.allowCoarseLidar &&
          element.tags?.["printmap:roof_reconstruction"] === "lidar" &&
          element.tags?.["printmap:roof_refinement"] !== "landmark"
        )) ||
      element.measuredSolid ||
      !element.tags?.building ||
      element.tags.building === "no" ||
      element.tags.location === "underground" ||
      Number(element.tags.layer) < 0
    )
      return false;
    const key = keyOf(element);
    if (seen.has(key)) return false;
    // A local refinement must remain small and native even in a huge project.
    // Bound each acquisition, not the number of landmarks in a project.
    const local = localRefinementBbox(element, ways, bbox);
    if (!local) return false;
    localBounds.set(key, local);
    seen.add(key);
    return true;
  });
  const selectedRelations = new Set(
    selected.filter((e) => e.type === "relation"),
  );
  const memberWays = new Set(
    elements
      .filter(
        (e) =>
          e.type === "relation" &&
          (selectedRelations.has(e) ||
            (e.roofSurfaces?.length &&
              !(
                options.allowCoarseLidar &&
                e.tags?.["printmap:roof_reconstruction"] === "lidar" &&
                e.tags?.["printmap:roof_refinement"] !== "landmark"
              )) ||
            e.measuredSolid),
      )
      .flatMap((e) =>
        (e.members ?? []).filter((m) => m.type === "way").map((m) => m.ref),
      ),
  );
  const height = (element: OverpassElement) =>
    parseLengthMeters(element.tags?.height) ??
    (Number(element.tags?.["building:levels"]) || 0) * 3;
  const prioritized = selected
    .filter(
      (e) =>
        (e.type !== "way" || !memberWays.has(e.id)) &&
        !options.skipIds?.has(keyOf(e)),
    )
    .sort(
      (a, b) =>
        Number(availableGrids?.has(keyOf(b)) ?? false) -
          Number(availableGrids?.has(keyOf(a)) ?? false) ||
        Number(catalog.has(keyOf(b))) - Number(catalog.has(keyOf(a))) ||
        height(b) - height(a) ||
        keyOf(a).localeCompare(keyOf(b)),
    );
  return { selected: prioritized, ways, localBounds };
}

/** Recompute progress from source geometry; caller-provided counts are not trusted. */
export function landmarkRefinementProgress(
  elements: OverpassElement[],
  bbox: BBox,
  previous?: LandmarkRefinementProgress,
  retry = false,
): LandmarkRefinementProgress {
  const eligible = landmarkRefinementCandidates(elements, bbox, undefined, {
    allowCoarseLidar: true,
  }).selected;
  const ids = new Set(eligible.map(keyOf));
  const attempts = (previous?.attempts ?? []).filter(
    (entry) => ids.has(entry.id) && !(retry && entry.outcome !== "budget"),
  );
  const attempted = new Set(attempts.map((entry) => entry.id));
  const completed = new Set(
    elements
      .filter(
        (element) =>
          element.roofSurfaces?.length &&
          element.tags?.["printmap:roof_reconstruction"] === "lidar" &&
          element.tags?.["printmap:roof_refinement"] === "landmark",
      )
      .map(keyOf),
  ).size;
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    remaining: eligible.filter((element) => !attempted.has(keyOf(element)))
      .length,
    completed,
    failed: attempts.filter((entry) => entry.outcome !== "budget").length,
    limited: attempts.filter((entry) => entry.outcome === "budget").length,
    attempts,
  };
}

/** Fetch two named civic landmarks per batch, in any metropolitan French city.
 * A persisted project queue continues with subsequent batches; retain surveys. */
export async function fetchIGNLandmarkRoofGrids(
  elements: OverpassElement[],
  bbox: BBox,
  signal: AbortSignal,
  options: { allowCoarseLidar?: boolean; skipIds?: ReadonlySet<string> } = {},
): Promise<IGNLandmarkRoofGrids> {
  signal.throwIfAborted();
  const { selected, localBounds } = landmarkRefinementCandidates(
    elements,
    bbox,
    undefined,
    options,
  );
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  const result: IGNLandmarkRoofGrids = { grids: new Map(), warnings: [] };
  await Promise.all(
    selected.slice(0, 2).map(async (element) => {
      try {
        const localBbox = localBounds.get(keyOf(element))!;
        const grid = await fetchIGNRoofGrid(localBbox, deadline);
        if (grid.resolutionM !== 0.5)
          throw new Error("La grille locale n’est pas native.");
        result.grids.set(keyOf(element), grid);
      } catch {
        signal.throwIfAborted();
        result.warnings.push(
          `${nameOf(element)} : surface LiDAR locale momentanément indisponible ; les données précédentes sont conservées.`,
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
  options: {
    grids?: Map<string, IGNRoofGrid>;
    cpuBudgetMs?: number;
    allowCoarseLidar?: boolean;
    skipIds?: ReadonlySet<string>;
    maxTotalLidarTriangles?: number;
  } = {},
): Promise<
  IGNRoofEnrichment & { attempts: LandmarkRefinementProgress["attempts"] }
> {
  signal.throwIfAborted();
  const result: IGNRoofEnrichment & {
    attempts: LandmarkRefinementProgress["attempts"];
  } = {
    elements,
    buildingCount: 0,
    surfaceCount: 0,
    triangleCount: 0,
    resolutionM: null,
    sources: [],
    warnings: [],
    attempts: [],
  };
  const candidates = landmarkRefinementCandidates(
    elements,
    bbox,
    options.grids,
    options,
  );
  const selected = candidates.selected.slice(0, 2),
    ways = candidates.ways;
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
    : await fetchIGNLandmarkRoofGrids(elements, bbox, signal, options);
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
  const trianglesOf = (element: OverpassElement) =>
    (element.roofSurfaces ?? []).reduce(
      (sum, surface) =>
        sum +
        surface.outer.length +
        surface.holes.reduce((n, ring) => n + ring.length, 0) +
        surface.holes.length -
        3,
      0,
    );
  let lidarTriangles = elements.reduce(
    (sum, element) =>
      sum +
      (element.tags?.["printmap:roof_reconstruction"] === "lidar"
        ? trianglesOf(element)
        : 0),
    0,
  );
  const attempt = (
    element: OverpassElement,
    outcome: LandmarkRefinementProgress["attempts"][number]["outcome"],
    reason: string,
  ) => result.attempts.push({ id: keyOf(element), outcome, reason });
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
    if (!native) {
      attempt(
        element,
        "unavailable",
        "Relevé local indisponible ou délai de collecte dépassé.",
      );
      continue;
    }
    if (native.resolutionM !== 0.5) {
      attempt(
        element,
        "unavailable",
        "Source locale au pas natif de 0,5 m indisponible.",
      );
      result.warnings.push(
        `${nameOf(element)} : le relevé local au pas natif de 0,5 m est absent ; les données précédentes sont conservées.`,
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
      attempt(
        element,
        "unavailable",
        "La reconstruction de cet édifice a dépassé le temps du lot. Une nouvelle tentative reste possible.",
      );
      result.warnings.push(
        "Affinement LiDAR des repères interrompu à la limite du temps CPU disponible ; les données précédentes sont conservées.",
      );
      break;
    }
    if (!roof) {
      attempt(
        element,
        "invalid",
        "La source ne satisfait pas les contrôles de reconstruction.",
      );
      result.warnings.push(
        `${nameOf(element)} : la surface LiDAR locale ne satisfait pas les contrôles de reconstruction ; les données précédentes sont conservées.`,
      );
      continue;
    }
    const vertices = vertexCount(roof.surfaces);
    const previousVertices = vertexCount(element.roofSurfaces ?? []);
    const previousTriangles =
      element.tags?.["printmap:roof_reconstruction"] === "lidar"
        ? trianglesOf(element)
        : 0;
    const existing = !!element.roofSurfaces?.length;
    if (
      result.triangleCount + roof.triangleCount > 8192 ||
      importVertices - previousVertices + vertices > MAX_ROOF_VERTICES ||
      importBuildings + (existing ? 0 : 1) > MAX_ROOF_BUILDINGS ||
      (options.maxTotalLidarTriangles != null &&
        lidarTriangles - previousTriangles + roof.triangleCount >
          options.maxTotalLidarTriangles)
    ) {
      attempt(
        element,
        "budget",
        "Limite de géométrie de cette plaque atteinte ; les surfaces précédentes restent conservées.",
      );
      result.warnings.push(
        `${nameOf(element)} : affinement LiDAR non ajouté pour respecter les budgets de géométrie et d’import du projet ; les données précédentes sont conservées.`,
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
    importVertices += vertices - previousVertices;
    importBuildings += existing ? 0 : 1;
    lidarTriangles += roof.triangleCount - previousTriangles;
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
