import type { ModelSettings } from "@/store/use-scene-store";
import type { BBox, ElevationGrid, MapDataResponse } from "@/types/osm";
import { createLocalProjection } from "@/lib/projection";
import { validateBbox } from "@/lib/data/bbox";
import { validateImportedElements } from "@/lib/data/validate-imported-elements";
import { validateRoofData } from "@/lib/data/validate-roofs";
import { sampleElevation } from "@/lib/elevation/sample-grid";
import { validateElevationGrid } from "@/lib/elevation/validate-grid";

export const ASSEMBLY_PLATE_SIZE_MM = 150;
export const ASSEMBLY_USABLE_MM = 145;
export const ASSEMBLY_TERRAIN_SEGMENTS = 64;
export const MAX_ASSEMBLY_CELLS = 100;
export const MAX_ASSEMBLY_EXTENT_M = 48000;
export const MIN_ASSEMBLY_SCALE = 200;
export const MAX_ASSEMBLY_SCALE = 34000;

/** Local vertical headroom for an inland project; coastal projects retain sea level. */
export function initialAssemblyDatum(minimumM: number): number {
  if (!Number.isFinite(minimumM) || minimumM <= -12000 || minimumM >= 9000)
    throw new Error("Altitude de référence invalide.");
  return minimumM >= 0
    ? Math.max(0, Math.floor(minimumM / 50) * 50 - 50)
    : Math.floor(minimumM / 50) * 50 - 50;
}

export interface AssemblyCell {
  col: number;
  row: number;
}
export type AssemblyDirection = "north" | "south" | "east" | "west";
export interface AssemblyProject {
  version: 1;
  id: string;
  name: string;
  origin: { lat: number; lng: number };
  scale: number;
  plateSizeMm: 150;
  usableMm: 145;
  elevationDatumM: number | null;
  terrainStepM: number;
  settings: ModelSettings;
  cells: AssemblyCell[];
  activeCell: AssemblyCell | null;
  /** Absolute elevations, keyed by global integer sample coordinates x,y. */
  boundaryElevations: Record<string, number>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validAltitude = (value: unknown): value is number =>
  finite(value) && value > -12000 && value < 9000;

export function validateAssemblyCell(value: unknown): AssemblyCell {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.col) ||
    !Number.isSafeInteger(value.row) ||
    Math.abs(value.col as number) > 1000000 ||
    Math.abs(value.row as number) > 1000000
  )
    throw new Error("Indices de plaque invalides.");
  return { col: value.col as number, row: value.row as number };
}

export function cellKey(cell: AssemblyCell): string {
  const { col, row } = validateAssemblyCell(cell);
  return `${col},${row}`;
}

export function cellLabel(cell: AssemblyCell): string {
  const { col, row } = validateAssemblyCell(cell);
  return `C${col} · L${row}`;
}

export function validateAssemblyId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("Identifiant du projet invalide.");
  return value;
}

/** Small JSON settings only; never import the Zustand store at runtime. */
function cloneSettings(value: unknown): ModelSettings {
  let entries = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++entries > 10000 || depth > 16)
      throw new Error("Paramètres du projet trop volumineux.");
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item))
      return item.map((child) => visit(child, depth + 1));
    if (!record(item)) throw new Error("Paramètres du projet invalides.");
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [
        key,
        visit(child, depth + 1),
      ]),
    );
  };
  const copy = visit(value, 0);
  if (
    !record(copy) ||
    !record(copy.base) ||
    !record(copy.features) ||
    !record(copy.print) ||
    !record(copy.base.frame) ||
    !record(copy.base.grid)
  )
    throw new Error("Paramètres du projet incomplets.");
  for (const layer of [
    "buildings",
    "roads",
    "water",
    "parks",
    "sand",
    "piers",
    "gpx",
  ])
    if (!record(copy.features[layer]))
      throw new Error(`Couche ${layer} manquante.`);
  return copy as unknown as ModelSettings;
}

/** Reject physical changes to saved settings; normalization belongs to the caller. */
function validateSettings(value: unknown): ModelSettings {
  const settings = cloneSettings(value);
  const { base, features, print } = settings;
  if (
    base.grid.cols !== 1 ||
    base.grid.rows !== 1 ||
    base.plateSizeMm !== 150 ||
    base.frame.enabled !== false ||
    base.frame.textEnabled !== false
  )
    throw new Error(
      "Chaque plaque du projet doit utiliser 150 mm, une grille 1 × 1 et aucun cadre.",
    );
  const ranges = [
    [base.basePlateThicknessMm, 1, 15],
    [base.elevationExaggeration, 0.5, 5],
    [print.minFeatureMm, 0.15, 3],
    [print.minBuildingAreaMm2, 0, 30],
    [print.minBuildingHeightMm, 0.15, 5],
    [print.simplifyMm, 0, 1],
    [features.buildings.buildingScale, 0.5, 3],
    [features.buildings.minHeightM, 0, 1000],
    [features.buildings.minAreaM2, 0, 1e6],
    [features.roads.widthMultiplier, 0.5, 3],
    [features.water.minAreaM2, 0, 1e6],
    [base.frame.thicknessMm, 1, 10],
    [base.frame.heightMm, 0.1, 5],
  ];
  if (ranges.some(([n, min, max]) => !finite(n) || n < min || n > max))
    throw new Error("Dimensions du projet invalides.");
  if (
    typeof base.topographyEnabled !== "boolean" ||
    typeof features.buildings.roofs !== "boolean" ||
    (features.buildings.documentedFacades !== undefined &&
      typeof features.buildings.documentedFacades !== "boolean") ||
    typeof features.roads.footpathsEnabled !== "boolean" ||
    !record(features.roads.roadTypeEnabled) ||
    Object.values(features.roads.roadTypeEnabled).some(
      (v) => typeof v !== "boolean",
    ) ||
    !["all", "minor", "major"].includes(features.roads.filter)
  )
    throw new Error("Options du projet invalides.");
  const color = (v: unknown) =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
  if (
    ![base.baseColor, base.frame.color, features.buildings.roofColor].every(
      color,
    )
  )
    throw new Error("Couleurs du projet invalides.");
  for (const [layer, config] of Object.entries(features)) {
    if (
      !record(config) ||
      typeof config.enabled !== "boolean" ||
      !color(config.color)
    )
      throw new Error(`Couche ${layer} invalide.`);
    if ("heightMm" in config) {
      const min =
        layer === "roads"
          ? -1.2
          : ["water", "parks", "sand"].includes(layer)
            ? -0.8
            : 0.1;
      if (
        !finite(config.heightMm) ||
        config.heightMm < min ||
        config.heightMm > 5
      )
        throw new Error(`Hauteur ${layer} invalide.`);
    }
  }
  return settings;
}

function sideM(project: Pick<AssemblyProject, "scale">): number {
  return (ASSEMBLY_USABLE_MM * project.scale) / 1000;
}

function rawCellBbox(
  project: Pick<AssemblyProject, "origin" | "scale">,
  cell: AssemblyCell,
): BBox {
  const projection = createLocalProjection(
    project.origin.lat,
    project.origin.lng,
  );
  const side = sideM(project);
  const [west, south] = projection.unproject(cell.col * side, cell.row * side);
  const [east, north] = projection.unproject(
    (cell.col + 1) * side,
    (cell.row + 1) * side,
  );
  return [south, west, north, east];
}

/** Geographic bounds of one square in the fixed origin projection. */
export function assemblyCellBbox(
  project: AssemblyProject,
  cell: AssemblyCell,
): BBox {
  return validateBbox(rawCellBbox(project, validateAssemblyCell(cell)));
}

export function assemblyBounds(project: AssemblyProject): BBox {
  if (!project.cells.length)
    throw new Error("Le projet ne contient aucune plaque.");
  const bounds = project.cells.map((cell) => assemblyCellBbox(project, cell));
  return [
    Math.min(...bounds.map((b) => b[0])),
    Math.min(...bounds.map((b) => b[1])),
    Math.max(...bounds.map((b) => b[2])),
    Math.max(...bounds.map((b) => b[3])),
  ];
}

function boundaryKeys(cell: AssemblyCell): string[] {
  const x = cell.col * ASSEMBLY_TERRAIN_SEGMENTS,
    y = cell.row * ASSEMBLY_TERRAIN_SEGMENTS;
  const keys: string[] = [];
  for (let n = 0; n <= ASSEMBLY_TERRAIN_SEGMENTS; n++) {
    keys.push(`${x + n},${y}`, `${x + n},${y + ASSEMBLY_TERRAIN_SEGMENTS}`);
    if (n > 0 && n < ASSEMBLY_TERRAIN_SEGMENTS)
      keys.push(`${x},${y + n}`, `${x + ASSEMBLY_TERRAIN_SEGMENTS},${y + n}`);
  }
  return keys;
}

/** Validate a plan without loading any parcel data or changing its saved settings. */
export function validateAssemblyProject(input: unknown): AssemblyProject {
  if (
    !record(input) ||
    input.version !== 1 ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 200 ||
    !record(input.origin) ||
    !finite(input.origin.lat) ||
    Math.abs(input.origin.lat) > 85 ||
    !finite(input.origin.lng) ||
    Math.abs(input.origin.lng) > 180 ||
    !finite(input.scale) ||
    input.scale < MIN_ASSEMBLY_SCALE ||
    input.scale > MAX_ASSEMBLY_SCALE ||
    input.plateSizeMm !== ASSEMBLY_PLATE_SIZE_MM ||
    input.usableMm !== ASSEMBLY_USABLE_MM ||
    !(input.elevationDatumM === null || validAltitude(input.elevationDatumM)) ||
    !finite(input.terrainStepM) ||
    Math.abs(
      input.terrainStepM -
        (ASSEMBLY_USABLE_MM * input.scale) / 1000 / ASSEMBLY_TERRAIN_SEGMENTS,
    ) > 1e-10 ||
    !Array.isArray(input.cells) ||
    !input.cells.length ||
    input.cells.length > MAX_ASSEMBLY_CELLS ||
    !record(input.boundaryElevations)
  )
    throw new Error(
      "Plan de maquette invalide (100 plaques au maximum, échelle 1:200 à 1:34000).",
    );
  const cells = input.cells.map(validateAssemblyCell);
  const keys = new Set(cells.map(cellKey));
  if (keys.size !== cells.length || !keys.has("0,0"))
    throw new Error(
      "Le plan doit conserver son origine et des plaques uniques.",
    );
  const seen = new Set<string>(),
    queue: AssemblyCell[] = [cells[0]];
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i],
      key = cellKey(cell);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = { col: cell.col + dc, row: cell.row + dr };
      if (keys.has(cellKey(next)) && !seen.has(cellKey(next))) queue.push(next);
    }
  }
  if (seen.size !== cells.length)
    throw new Error("Les plaques du plan doivent être reliées par un côté.");
  const side = (ASSEMBLY_USABLE_MM * input.scale) / 1000;
  const minX = Math.min(...cells.map((c) => c.col)) * side,
    maxX = (Math.max(...cells.map((c) => c.col)) + 1) * side;
  const minY = Math.min(...cells.map((c) => c.row)) * side,
    maxY = (Math.max(...cells.map((c) => c.row)) + 1) * side;
  if (
    Math.max(
      maxX - minX,
      maxY - minY,
      Math.abs(minX),
      Math.abs(maxX),
      Math.abs(minY),
      Math.abs(maxY),
    ) > MAX_ASSEMBLY_EXTENT_M
  )
    throw new Error(
      "Le projet ne peut pas s’étendre au-delà de 48 km par axe autour de son origine.",
    );
  const origin = { lat: input.origin.lat, lng: input.origin.lng };
  for (const cell of cells)
    validateBbox(rawCellBbox({ origin, scale: input.scale }, cell));
  const activeCell =
    input.activeCell === null ? null : validateAssemblyCell(input.activeCell);
  if (activeCell && !keys.has(cellKey(activeCell)))
    throw new Error("La plaque active n’appartient pas au plan.");
  const allowed = new Set(cells.flatMap(boundaryKeys));
  const entries = Object.entries(input.boundaryElevations);
  if (
    entries.length > MAX_ASSEMBLY_CELLS * ASSEMBLY_TERRAIN_SEGMENTS * 4 ||
    entries.some(([key, z]) => !allowed.has(key) || !validAltitude(z))
  )
    throw new Error("Les altitudes des bords du projet sont invalides.");
  return {
    version: 1,
    id: validateAssemblyId(input.id),
    name: input.name,
    origin,
    scale: input.scale,
    plateSizeMm: 150,
    usableMm: 145,
    elevationDatumM: input.elevationDatumM,
    terrainStepM: input.terrainStepM,
    settings: validateSettings(input.settings),
    cells,
    activeCell,
    boundaryElevations: Object.fromEntries(entries) as Record<string, number>,
  };
}

export function createAssemblyProject(
  bbox: BBox,
  scale: number,
  settings: ModelSettings,
  name: string,
): AssemblyProject {
  validateBbox(bbox);
  if (
    !finite(scale) ||
    scale < MIN_ASSEMBLY_SCALE ||
    scale > MAX_ASSEMBLY_SCALE
  )
    throw new Error("Choisissez une échelle entre 1:200 et 1:34000.");
  const origin = { lat: bbox[0], lng: bbox[1] },
    projection = createLocalProjection(origin.lat, origin.lng);
  const [width, height] = projection.project(bbox[3], bbox[2]);
  const side = (ASSEMBLY_USABLE_MM * scale) / 1000;
  // Avoid an extra tile due only to inverse-projection roundoff on an exact boundary.
  const cols = Math.max(1, Math.ceil(width / side - 1e-10)),
    rows = Math.max(1, Math.ceil(height / side - 1e-10));
  if (cols * rows > MAX_ASSEMBLY_CELLS)
    throw new Error(
      "Cette sélection dépasse 100 plaques à cette échelle. Réduisez la zone ou augmentez l’échelle.",
    );
  const normalized = cloneSettings(settings);
  normalized.base.grid = { cols: 1, rows: 1 };
  normalized.base.plateSizeMm = 150;
  normalized.base.frame.enabled = false;
  normalized.base.frame.textEnabled = false;
  return validateAssemblyProject({
    version: 1,
    id: globalThis.crypto.randomUUID(),
    name,
    origin,
    scale,
    plateSizeMm: 150,
    usableMm: 145,
    elevationDatumM: null,
    terrainStepM: side / ASSEMBLY_TERRAIN_SEGMENTS,
    settings: normalized,
    cells: Array.from({ length: cols * rows }, (_, i) => ({
      col: i % cols,
      row: Math.floor(i / cols),
    })),
    activeCell: { col: 0, row: 0 },
    boundaryElevations: {},
  });
}

export function addAssemblyNeighbor(
  project: AssemblyProject,
  cell: AssemblyCell,
  direction: AssemblyDirection,
): AssemblyProject {
  const current = validateAssemblyProject(project);
  if (!current.cells.some((c) => cellKey(c) === cellKey(cell)))
    throw new Error("La plaque de départ n’appartient pas au plan.");
  const delta = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] }[
    direction
  ];
  if (!delta) throw new Error("Direction d’extension invalide.");
  const neighbor = { col: cell.col + delta[0], row: cell.row + delta[1] };
  const exists = current.cells.some((c) => cellKey(c) === cellKey(neighbor));
  return validateAssemblyProject({
    ...current,
    cells: exists ? current.cells : [...current.cells, neighbor],
    activeCell: neighbor,
  });
}

function validateGridMetadata(grid: ElevationGrid): ElevationGrid {
  const validated = validateElevationGrid(grid);
  if (
    (grid.source !== undefined &&
      (typeof grid.source !== "string" || grid.source.length > 4000)) ||
    (grid.resolutionM !== undefined &&
      (!finite(grid.resolutionM) ||
        grid.resolutionM <= 0 ||
        grid.resolutionM > 1e6)) ||
    (grid.warnings !== undefined && !stringList(grid.warnings))
  )
    throw new Error("Provenance du relief invalide.");
  return validated;
}

function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 2000 &&
    value.every((s) => typeof s === "string" && s.length <= 4000)
  );
}

/** Validate raw cell data before importing/caching it; never synthesize provenance. */
export function validateAssemblyData(
  input: unknown,
  bbox?: BBox,
): MapDataResponse {
  if (!record(input) || !record(input.osmData) || !record(input.report))
    throw new Error("Données de plaque invalides.");
  if (bbox) validateBbox(bbox);
  validateImportedElements(input.osmData.elements);
  validateRoofData(input.osmData.elements);
  const report = input.report;
  if (report.landmarkRefinement !== undefined) {
    const queue = report.landmarkRefinement;
    if (
      !record(queue) ||
      queue.version !== 1 ||
      typeof queue.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(queue.updatedAt)) ||
      ![queue.remaining, queue.completed, queue.failed, queue.limited].every(
        (value) =>
          finite(value) &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 15000,
      ) ||
      !Array.isArray(queue.attempts) ||
      queue.attempts.length > 15000 ||
      queue.attempts.some(
        (entry: unknown) =>
          !record(entry) ||
          typeof entry.id !== "string" ||
          !/^(way|relation)\/-?\d{1,16}$/.test(entry.id) ||
          !["unavailable", "invalid", "budget"].includes(
            entry.outcome as string,
          ) ||
          typeof entry.reason !== "string" ||
          entry.reason.length > 1000,
      ) ||
      new Set(queue.attempts.map((entry: { id: string }) => entry.id)).size !==
        queue.attempts.length
    )
      throw new Error("Progression des détails de la plaque invalide.");
  }
  if (
    !stringList(report.sources) ||
    !stringList(report.warnings) ||
    typeof report.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(report.fetchedAt)) ||
    !["available", "unavailable"].includes(report.seaCoverage as string) ||
    !(
      report.elevationSource === null ||
      typeof report.elevationSource === "string"
    ) ||
    !(
      report.elevationResolutionM === null ||
      (finite(report.elevationResolutionM) && report.elevationResolutionM > 0)
    )
  )
    throw new Error("Provenance des données de plaque invalide.");
  for (const key of [
    "areaKm2",
    "elementCount",
    "buildingCount",
    "measuredBuildingCount",
    "ignBuildingCount",
  ])
    if (
      !finite(report[key]) ||
      report[key] < 0 ||
      (key !== "areaKm2" && !Number.isInteger(report[key]))
    )
      throw new Error("Comptages des données de plaque invalides.");
  for (const [key, value] of Object.entries(report)) {
    if (
      key.endsWith("Count") &&
      value !== undefined &&
      (!finite(value) || value < 0 || !Number.isInteger(value))
    )
      throw new Error("Comptages des données de plaque invalides.");
  }
  if (
    report.lod2Year !== undefined &&
    (!Number.isInteger(report.lod2Year) ||
      (report.lod2Year as number) < 1900 ||
      (report.lod2Year as number) > 2100)
  )
    throw new Error("Millésime 3D invalide.");
  if (
    report.osmTimestamp !== undefined &&
    (typeof report.osmTimestamp !== "string" ||
      !Number.isFinite(Date.parse(report.osmTimestamp)))
  )
    throw new Error("Date OpenStreetMap invalide.");
  const grid =
    input.elevationGrid === null
      ? null
      : validateGridMetadata(input.elevationGrid as ElevationGrid);
  if (
    grid &&
    bbox &&
    [grid.south, grid.west, grid.north, grid.east].some(
      (coordinate, i) => Math.abs(coordinate - bbox[i]) > 1e-8,
    )
  )
    throw new Error("Le relief de la plaque ne correspond pas à sa zone.");
  return { ...input, elevationGrid: grid } as unknown as MapDataResponse;
}

/**
 * Regrid on the project's fixed global lattice. A saved boundary wins over a
 * later provider response, including all shared corners. Absolute datum is
 * never changed or clamped here; the caller rejects terrain below its datum.
 */
export function alignAssemblyElevation(
  project: AssemblyProject,
  cell: AssemblyCell,
  grid: ElevationGrid,
): {
  grid: ElevationGrid;
  boundaryElevations: Record<string, number>;
} {
  const current = validateAssemblyProject(project);
  if (!current.cells.some((c) => cellKey(c) === cellKey(cell)))
    throw new Error("La plaque n’appartient pas au plan.");
  const bbox = assemblyCellBbox(current, cell),
    source = validateGridMetadata(grid);
  if (
    source.south > bbox[0] + 1e-10 ||
    source.west > bbox[1] + 1e-10 ||
    source.north < bbox[2] - 1e-10 ||
    source.east < bbox[3] - 1e-10
  )
    throw new Error("La grille de relief ne couvre pas toute la plaque.");
  const boundaryElevations = { ...current.boundaryElevations };
  const projection = createLocalProjection(
    current.origin.lat,
    current.origin.lng,
  );
  const points: number[] = [];
  // Cached aligned grids already occupy this lattice. Preserve their exact
  // samples instead of accumulating inverse-projection roundoff on every load.
  const sameLattice =
    source.rows === ASSEMBLY_TERRAIN_SEGMENTS + 1 &&
    source.cols === ASSEMBLY_TERRAIN_SEGMENTS + 1 &&
    [source.south, source.west, source.north, source.east].every(
      (value, i) => value === bbox[i],
    );
  let reused = false;
  for (let r = 0; r <= ASSEMBLY_TERRAIN_SEGMENTS; r++) {
    for (let c = 0; c <= ASSEMBLY_TERRAIN_SEGMENTS; c++) {
      const x = cell.col * ASSEMBLY_TERRAIN_SEGMENTS + c,
        y = cell.row * ASSEMBLY_TERRAIN_SEGMENTS + r;
      const [lng, lat] = projection.unproject(
        x * current.terrainStepM,
        y * current.terrainStepM,
      );
      const z = sameLattice
        ? source.points[r * source.cols + c]
        : sampleElevation(source, lat, lng);
      const edge =
        c === 0 ||
        r === 0 ||
        c === ASSEMBLY_TERRAIN_SEGMENTS ||
        r === ASSEMBLY_TERRAIN_SEGMENTS;
      const key = `${x},${y}`;
      if (edge && Object.hasOwn(boundaryElevations, key)) {
        reused ||= Math.abs(boundaryElevations[key] - z) > 1e-8;
        points.push(boundaryElevations[key]);
      } else {
        points.push(z);
        if (edge) boundaryElevations[key] = z;
      }
    }
  }
  const warnings = [...(source.warnings ?? [])];
  if (reused)
    warnings.push(
      "Les altitudes des bords déjà préparés sont conservées pour raccorder les plaques du projet.",
    );
  return {
    boundaryElevations,
    grid: {
      ...source,
      south: bbox[0],
      west: bbox[1],
      north: bbox[2],
      east: bbox[3],
      rows: ASSEMBLY_TERRAIN_SEGMENTS + 1,
      cols: ASSEMBLY_TERRAIN_SEGMENTS + 1,
      points,
      minElev: Math.min(...points),
      maxElev: Math.max(...points),
      resolutionM: Math.max(source.resolutionM ?? 0, current.terrainStepM),
      warnings: [...new Set(warnings)],
    },
  };
}
