import type { PrintModel } from "@/types/print";
import type { GridSettings } from "@/store/use-scene-store";
import { usablePlateSize } from "../plate-layout";

export function validateExportLayout(model: PrintModel, grid?: GridSettings) {
  if (
    grid &&
    (grid.cols * grid.rows !== (model.tiles.length || 1) ||
      model.tiles.some(
        (tile) => tile.col >= grid.cols || tile.row >= grid.rows,
      ))
  )
    throw new Error(
      "La grille a changé. Régénérez la maquette avant l’export.",
    );
  if (model.plateSizeMm != null) {
    const usable = usablePlateSize(model.plateSizeMm);
    const pieces = model.tiles.length
      ? model.tiles
      : [
          {
            widthMm: model.dimensions.widthMm,
            depthMm: model.dimensions.depthMm,
          },
        ];
    if (
      pieces.some(
        (piece) =>
          piece.widthMm > usable + 0.0001 || piece.depthMm > usable + 0.0001,
      )
    )
      throw new Error(
        `Une pièce dépasse la surface utile de ${usable} × ${usable} mm. Adaptez le découpage avant d’exporter.`,
      );
  }
}

/** Labels match tuile_ROW_COL filenames, with north at the top. */
export function assemblyPlanSVG(model: PrintModel): string {
  const { widthMm, depthMm } = model.dimensions;
  const cols = Math.max(...model.tiles.map((tile) => tile.col)) + 1;
  const rows = Math.max(...model.tiles.map((tile) => tile.row)) + 1;
  const w = widthMm / cols,
    h = depthMm / rows;
  const font = Math.min(w / 5, h / 4, 9);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 ${widthMm + 20} ${depthMm + 30}" width="700" role="img"><title>Plan d’assemblage, nord en haut. ${widthMm.toFixed(1)} × ${depthMm.toFixed(1)} mm.</title><rect x="-10" y="-20" width="${widthMm + 20}" height="${depthMm + 30}" fill="#fff"/><text x="${widthMm / 2}" y="-6" text-anchor="middle" font-size="8">NORD ↑</text>${model.tiles
    .map((tile) => {
      const x = tile.col * w,
        y = (rows - 1 - tile.row) * h;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e7ede5" stroke="#486352" stroke-width="0.4"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${font}">${tile.row + 1}–${tile.col + 1}</text>`;
    })
    .join("")}</svg>`;
}
