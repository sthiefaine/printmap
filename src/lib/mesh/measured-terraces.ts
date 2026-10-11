import type { Point2D, Polygon2D } from "@/types/geometry";
import type { ElevationGrid, OverpassElement } from "@/types/osm";
import { elementPolygons } from "../osm/relation-polygons";
import { pointInPolygon } from "../polygon/point-in-polygon";

export interface TerraceConstraint {
  /** Positive masks to union, then subtract exclusions and intersect the selection. */
  polygons: Polygon2D[];
  exclusions: Polygon2D[];
  plane: {
    originMm: Point2D;
    elevationM: number;
    dzDxMPerMm: number;
    dzDyMPerMm: number;
  };
  elevationAt: (x: number, y: number) => number;
  contains: (x: number, y: number) => boolean;
  name: string;
  mode: "estimated-from-dem";
  sourceIds: string[];
  source: string;
  sourceUrl: string;
  sampleCount: number;
  rejectedSamples: number;
  fitRmsM: number;
  slopePercent: number;
}

type Sample = [number, number, number];
const ARCHIVE = "https://archives.montpellier.fr/peyrou";

function distanceToRing(point: Point2D, ring: Point2D[]) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      n = dx * dx + dy * dy;
    const t = n
      ? Math.max(
          0,
          Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / n),
        )
      : 0;
    best = Math.min(
      best,
      Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy),
    );
  }
  return best;
}

function contains(point: Point2D, polygon: Polygon2D) {
  return (
    (pointInPolygon(...point, polygon.outer) ||
      distanceToRing(point, polygon.outer) <= 1e-7) &&
    !polygon.holes.some(
      (hole) =>
        pointInPolygon(...point, hole) || distanceToRing(point, hole) <= 1e-7,
    )
  );
}

function clipRing(ring: Point2D[], value: (point: Point2D) => number) {
  const result: Point2D[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      av = value(a),
      bv = value(b);
    if (av >= -1e-9) result.push(a);
    if (av >= 0 !== bv >= 0) {
      const t = av / (av - bv);
      result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return result.filter(
    (p, i) =>
      !i || Math.hypot(p[0] - result[i - 1][0], p[1] - result[i - 1][1]) > 1e-8,
  );
}

/** Split at the actual mapped landings, leaving the staircase corridor between levels. */
function plateauSide(
  outer: Point2D[],
  landings: Point2D[],
  west: boolean,
): Polygon2D[] {
  const points = [...landings].sort((a, b) => a[1] - b[1]);
  const polygons: Polygon2D[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    if (Math.abs(b[1] - a[1]) < 1e-8) return [];
    let ring = outer;
    if (i) ring = clipRing(ring, (p) => p[1] - a[1]);
    if (i + 1 < points.length - 1) ring = clipRing(ring, (p) => b[1] - p[1]);
    const boundaryX = (y: number) =>
      a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    ring = clipRing(ring, (p) => (west ? -1 : 1) * (p[0] - boundaryX(p[1])));
    if (ring.length >= 3) polygons.push({ outer: ring, holes: [] });
  }
  return polygons;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function leastSquares(samples: Sample[]): [number, number, number] | null {
  const matrix = Array.from({ length: 3 }, (_, a) =>
    [0, 1, 2]
      .map((b) =>
        samples.reduce((sum, [x, y]) => sum + [x, y, 1][a] * [x, y, 1][b], 0),
      )
      .concat(samples.reduce((sum, [x, y, z]) => sum + [x, y, 1][a] * z, 0)),
  );
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++)
      if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const divisor = matrix[i][i];
    if (Math.abs(divisor) < 1e-9) return null;
    matrix[i] = matrix[i].map((v) => v / divisor);
    for (let j = 0; j < 3; j++)
      if (j !== i) {
        const factor = matrix[j][i];
        matrix[j] = matrix[j].map((v, k) => v - factor * matrix[i][k]);
      }
  }
  return matrix.map((row) => row[3]) as [number, number, number];
}

/** Reject wall-edge interpolation; preserve gentle measured drainage slope. */
function robustPlane(samples: Sample[], horizontal = false) {
  if (samples.length < 12) return null;
  const origin: Point2D = [
    samples.reduce((sum, p) => sum + p[0], 0) / samples.length,
    samples.reduce((sum, p) => sum + p[1], 0) / samples.length,
  ];
  let kept: Sample[] = samples.map(([x, y, z]) => [
    x - origin[0],
    y - origin[1],
    z,
  ]);
  let coefficients: [number, number, number] | null = null;
  for (let iteration = 0; iteration < 4; iteration++) {
    coefficients = horizontal
      ? [0, 0, median(kept.map((p) => p[2]))]
      : leastSquares(kept);
    if (!coefficients) return null;
    const [a, b, c] = coefficients;
    const residuals = kept.map(([x, y, z]) => Math.abs(z - a * x - b * y - c));
    const cutoff = Math.max(0.15, 3 * median(residuals));
    const next = kept.filter((_, i) => residuals[i] <= cutoff);
    if (next.length < 12) return null;
    kept = next;
  }
  coefficients = horizontal
    ? [0, 0, median(kept.map((p) => p[2]))]
    : leastSquares(kept);
  if (!coefficients) return null;
  const [a, b, c] = coefficients;
  const rms = Math.sqrt(
    kept.reduce((sum, [x, y, z]) => sum + (z - a * x - b * y - c) ** 2, 0) /
      kept.length,
  );
  // Sparse/rough relief is not evidence of a surveyed terrace.
  if (rms > 0.35 || Math.hypot(a, b) > 0.02) return null;
  return {
    origin,
    coefficients,
    kept: kept.length,
    rejected: samples.length - kept.length,
    rms,
  };
}

/**
 * Site-specific constraints for the documented Peyrou terraces. OSM defines each
 * footprint; dense bare-earth samples estimate its level, not the château roof,
 * foundation or upper balcony. Other parks and the lower gardens keep their DEM.
 */
export function buildMeasuredTerraces(
  elements: OverpassElement[],
  grid: ElevationGrid | null,
  projectMm: (lon: number, lat: number) => Point2D,
  scaleFactor: number,
): TerraceConstraint[] {
  if (
    !grid ||
    !grid.source?.includes("IGN") ||
    !Number.isFinite(scaleFactor) ||
    scaleFactor <= 0 ||
    !Number.isInteger(grid.rows) ||
    !Number.isInteger(grid.cols) ||
    grid.rows < 2 ||
    grid.cols < 2 ||
    grid.rows > 500 ||
    grid.cols > 500 ||
    grid.points.length !== grid.rows * grid.cols ||
    ![grid.south, grid.north, grid.west, grid.east].every(Number.isFinite) ||
    grid.south >= grid.north ||
    grid.west >= grid.east ||
    !grid.points.every(Number.isFinite) ||
    !Number.isFinite(grid.resolutionM) ||
    grid.resolutionM! <= 0 ||
    grid.resolutionM! > 15
  )
    return [];
  const promenade = elements.find(
    (e) =>
      e.type === "relation" &&
      e.id === 3186605 &&
      e.tags?.highway === "pedestrian" &&
      e.tags?.name === "Promenade du Peyrou",
  );
  if (!promenade) return [];
  const geo = elementPolygons(promenade)[0];
  const central = promenade.members?.find(
    (m) => m.ref === 236821993 && m.role === "inner",
  )?.geometry;
  const basin = elements.find(
    (e) => e.type === "way" && e.id === 236815262 && e.tags?.water === "basin",
  );
  const steps = [471381363, 471740020, 471740023].map((id) =>
    elements.find(
      (e) =>
        e.type === "way" &&
        e.id === id &&
        e.tags?.highway === "steps" &&
        e.tags?.incline === "down" &&
        e.tags?.step_count === "5",
    ),
  );
  if (
    !geo ||
    !central ||
    !basin?.geometry ||
    steps.some((e) => !e?.geometry || e.geometry.length < 2)
  )
    return [];
  const ring = (vertices: Array<{ lon: number; lat: number }>) =>
    vertices.map((v) => projectMm(v.lon, v.lat));
  const outer = ring(geo.outer),
    parterre: Polygon2D = { outer: ring(central), holes: [] };
  const basinPolygon: Polygon2D = { outer: ring(basin.geometry), holes: [] };
  if (
    [...outer, ...parterre.outer, ...basinPolygon.outer].some(
      (p) => !p.every(Number.isFinite),
    )
  )
    return [];
  const high = steps.map((e) => ring(e!.geometry!)[0]),
    low = steps.map((e) => ring(e!.geometry!).at(-1)!);
  const east = plateauSide(outer, low, false),
    west = plateauSide(outer, high, true);
  if (!east.length || !west.length) return [];
  const structure = promenade.members?.find(
    (m) => m.ref === 25938154 && m.role === "inner",
  )?.geometry;
  const structuralExclusions: Polygon2D[] = structure
    ? [{ outer: ring(structure), holes: [] }]
    : [];
  const gridSamples: Sample[] = [];
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.cols; col++) {
      const [x, y] = projectMm(
        grid.west + (col / (grid.cols - 1)) * (grid.east - grid.west),
        grid.south + (row / (grid.rows - 1)) * (grid.north - grid.south),
      );
      if (Number.isFinite(x) && Number.isFinite(y))
        gridSamples.push([x, y, grid.points[row * grid.cols + col]]);
    }
  const definitions = [
    {
      name: "Parterre central du Peyrou",
      polygons: [parterre],
      exclusions: [],
      horizontal: false,
      sourceIds: ["relation/3186605", "way/236821993"],
      sample: (p: Point2D) =>
        contains(p, parterre) &&
        distanceToRing(p, parterre.outer) >= 8 * scaleFactor,
    },
    {
      name: "Allées de la promenade haute du Peyrou",
      polygons: east,
      exclusions: [parterre],
      horizontal: false,
      sourceIds: [
        "relation/3186605",
        "way/236821993",
        ...steps.map((e) => `way/${e!.id}`),
      ],
      sample: (p: Point2D) =>
        east.some((polygon) => contains(p, polygon)) &&
        !contains(p, parterre) &&
        distanceToRing(p, outer) >= 4 * scaleFactor &&
        distanceToRing(p, parterre.outer) >= scaleFactor,
    },
    {
      name: "Terrasse des eaux du Peyrou",
      polygons: west,
      exclusions: structuralExclusions,
      horizontal: true,
      sourceIds: [
        "relation/3186605",
        "way/236815262",
        ...steps.map((e) => `way/${e!.id}`),
      ],
      sample: (p: Point2D) =>
        west.some((polygon) => contains(p, polygon)) &&
        !contains(p, basinPolygon) &&
        !structuralExclusions.some((polygon) => contains(p, polygon)) &&
        distanceToRing(p, outer) >= 6 * scaleFactor &&
        distanceToRing(p, basinPolygon.outer) >= scaleFactor,
    },
  ];
  const result: TerraceConstraint[] = [];
  for (const definition of definitions) {
    const samples = gridSamples
      .filter(([x, y]) => definition.sample([x, y]))
      .map(([x, y, z]): Sample => [x / scaleFactor, y / scaleFactor, z]);
    const fit = robustPlane(samples, definition.horizontal);
    if (!fit) continue;
    const [a, b, c] = fit.coefficients;
    const plane = {
      originMm: [
        fit.origin[0] * scaleFactor,
        fit.origin[1] * scaleFactor,
      ] as Point2D,
      elevationM: c,
      dzDxMPerMm: a / scaleFactor,
      dzDyMPerMm: b / scaleFactor,
    };
    result.push({
      polygons: definition.polygons,
      exclusions: definition.exclusions,
      plane,
      elevationAt: (x, y) =>
        c +
        (x - plane.originMm[0]) * plane.dzDxMPerMm +
        (y - plane.originMm[1]) * plane.dzDyMPerMm,
      contains: (x, y) =>
        definition.polygons.some((p) => contains([x, y], p)) &&
        !definition.exclusions.some((p) => contains([x, y], p)),
      name: definition.name,
      mode: "estimated-from-dem",
      sourceIds: definition.sourceIds,
      source: `${grid.source} · limites © OpenStreetMap contributors · terrasses documentées par les Archives de Montpellier`,
      sourceUrl: ARCHIVE,
      sampleCount: fit.kept,
      rejectedSamples: fit.rejected,
      fitRmsM: fit.rms,
      slopePercent: Math.hypot(a, b) * 100,
    });
  }
  return result;
}
