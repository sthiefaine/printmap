import type { ElevationGrid } from "@/types/osm";
import { validateBbox } from "@/lib/data/bbox";

export function validateElevationGrid(value: unknown): ElevationGrid {
  if (!value || typeof value !== "object")
    throw new Error("Grille de relief invalide.");
  const grid = value as ElevationGrid;
  if (
    !Number.isInteger(grid.rows) ||
    !Number.isInteger(grid.cols) ||
    grid.rows < 2 ||
    grid.cols < 2 ||
    grid.rows > 128 ||
    grid.cols > 128
  )
    throw new Error(
      "Dimensions du relief invalides (2 à 128 points par côté).",
    );
  validateBbox([grid.south, grid.west, grid.north, grid.east]);
  if (
    !Array.isArray(grid.points) ||
    grid.points.length !== grid.rows * grid.cols ||
    !grid.points.every((z) => Number.isFinite(z) && z > -12000 && z < 9000)
  )
    throw new Error("Altitudes du relief invalides ou incomplètes.");
  const minElev = Math.min(...grid.points),
    maxElev = Math.max(...grid.points);
  return { ...grid, minElev, maxElev };
}
