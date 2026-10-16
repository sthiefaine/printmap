import type { Manifold, ManifoldToplevel } from "manifold-3d";
import { removeNumericalShells } from "./retain-shells";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

/** Existing profile policy, shared by the parent model and its cut tiles. */
export function underPrintResolution(
  part: Manifold,
  minimumFeatureMm: number,
): boolean {
  const volume = part.volume();
  if (volume <= 0 || volume >= minimumFeatureMm ** 3) return false;
  const bounds = part.boundingBox();
  return (
    bounds.min[2] > 0.001 &&
    Math.min(...bounds.max.map((value, axis) => value - bounds.min[axis])) <
      minimumFeatureMm
  );
}

/** Filter only real, tiny cantilever tips separated by an internal tile edge.
 * This is declared profile filtering before any numerical repair budget starts.
 * Larger tips, hollow fragments, negative cavity shells and grounded material
 * remain intact and must pass the ordinary print checks. */
export function filterCutFragments(
  cad: ManifoldToplevel,
  owner: Handles,
  cut: Manifold,
  options: {
    minimumFeatureMm: number;
    min: [number, number];
    max: [number, number];
    internalEdges: {
      west: boolean;
      east: boolean;
      south: boolean;
      north: boolean;
    };
    hasMaterial: (part: Manifold) => boolean;
  },
): { solid: Manifold; discardedCount: number; discardedVolumeMm3: number } {
  const parts = cut.decompose().map((part) => owner.keep(part));
  const cavities = parts
    .filter((part) => part.volume() < 0)
    .map((part) => part.boundingBox());
  const omitted = (part: Manifold) => {
    if (
      !options.hasMaterial(part) ||
      !underPrintResolution(part, options.minimumFeatureMm)
    )
      return false;
    const box = part.boundingBox();
    // Do not remove an outer shell while keeping its inverted cavity alone.
    if (
      cavities.some((cavity) =>
        cavity.min.every(
          (value, axis) =>
            value >= box.min[axis] - 0.00001 &&
            cavity.max[axis] <= box.max[axis] + 0.00001,
        ),
      )
    )
      return false;
    const edge = options.internalEdges;
    return (
      (edge.west && Math.abs(box.min[0] - options.min[0]) < 0.00001) ||
      (edge.east && Math.abs(box.max[0] - options.max[0]) < 0.00001) ||
      (edge.south && Math.abs(box.min[1] - options.min[1]) < 0.00001) ||
      (edge.north && Math.abs(box.max[1] - options.max[1]) < 0.00001)
    );
  };
  const tips = parts.filter(omitted);
  return {
    solid: tips.length
      ? removeNumericalShells(cad, owner, cut, (part) => !omitted(part))
      : cut,
    discardedCount: tips.length,
    discardedVolumeMm3: tips.reduce((sum, part) => sum + part.volume(), 0),
  };
}
