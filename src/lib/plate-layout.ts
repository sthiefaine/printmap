import type { BBox } from "@/types/osm";
import type { GridSettings } from "@/store/use-scene-store";
import { getBboxDimensions } from "./mesh/base-plate-mesh";

export const MAX_PRINT_TILES = 25;
export const PLATE_MARGIN_MM = 5;
export type PlateSizeMm = 100 | 150;
export interface PlateLayout {
  grid: GridSettings;
  count: number;
  plateSizeMm: PlateSizeMm;
  widthMm: number;
  depthMm: number;
  tileWidthMm: number;
  tileDepthMm: number;
  longSideMm: number;
  scale: number;
}
export function usablePlateSize(plate: PlateSizeMm) {
  if (plate !== 100 && plate !== 150)
    throw new Error("Choisissez des plaques de 10 ou 15 cm.");
  return plate - PLATE_MARGIN_MM;
}
export function validPrintGrid(grid: GridSettings) {
  return (
    Number.isInteger(grid.cols) &&
    Number.isInteger(grid.rows) &&
    grid.cols >= 1 &&
    grid.rows >= 1 &&
    grid.cols * grid.rows <= MAX_PRINT_TILES
  );
}
function dimensions(bbox: BBox) {
  if (
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3]
  )
    throw new Error("Sélectionnez une zone valide.");
  return getBboxDimensions(bbox, 1000);
}
/** Largest proportional model for exactly N plates; enumerate both orientations.
 * Prime counts legitimately produce strips rather than an incomplete grid. */
export function fitPlateCount(
  bbox: BBox,
  count: number,
  plate: PlateSizeMm,
): PlateLayout {
  const usable = usablePlateSize(plate);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PRINT_TILES)
    throw new Error(`Choisissez entre 1 et ${MAX_PRINT_TILES} plaques.`);
  const geographic = dimensions(bbox);
  let best: PlateLayout | undefined;
  for (let cols = 1; cols <= count; cols++) {
    if (count % cols) continue;
    const rows = count / cols;
    const factor = Math.min(
      (cols * usable) / geographic.widthMm,
      (rows * usable) / geographic.heightMm,
      1000 / Math.max(geographic.widthMm, geographic.heightMm),
    );
    const widthMm = geographic.widthMm * factor,
      depthMm = geographic.heightMm * factor;
    const candidate = {
      grid: { cols, rows },
      count,
      plateSizeMm: plate,
      widthMm,
      depthMm,
      tileWidthMm: widthMm / cols,
      tileDepthMm: depthMm / rows,
      longSideMm: Math.max(widthMm, depthMm),
      scale: 1000 / factor,
    };
    if (!best || candidate.scale < best.scale - 1e-9) best = candidate;
  }
  return best!;
}
/** Cut the existing physical size. Source scale, settings and geography stay fixed. */
export function splitAtCurrentScale(
  bbox: BBox,
  scale: number,
  plate: PlateSizeMm,
): PlateLayout {
  const usable = usablePlateSize(plate);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Échelle invalide.");
  const geographic = dimensions(bbox);
  const widthMm = (geographic.widthMm * 1000) / scale,
    depthMm = (geographic.heightMm * 1000) / scale;
  const cols = Math.max(1, Math.ceil(widthMm / usable - 1e-9));
  const rows = Math.max(1, Math.ceil(depthMm / usable - 1e-9));
  if (!validPrintGrid({ cols, rows }))
    throw new Error(
      `Plus de ${MAX_PRINT_TILES} plaques nécessaires. Réduisez la taille assemblée ou choisissez des plaques de 15 cm.`,
    );
  return {
    grid: { cols, rows },
    count: cols * rows,
    plateSizeMm: plate,
    widthMm,
    depthMm,
    tileWidthMm: widthMm / cols,
    tileDepthMm: depthMm / rows,
    longSideMm: Math.max(widthMm, depthMm),
    scale,
  };
}
