import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface SurveyedArchOptions {
  /** Surveyed bridge outline in model millimetres. */
  footprint: CrossSection;
  clip: CrossSection;
  center: Point2D;
  /** Span direction, parallel to the carried road; the passage crosses it. */
  axis: Point2D;
  spanMm: number;
  clearanceMm: number;
  groundZ: number;
  deckZ: number;
  foundationZ: number;
  minThicknessMm: number;
  /** This helper supports only an explicitly documented basket-handle profile. */
  profile: "basket-handle";
}

export interface SurveyedArch {
  solid: Manifold;
  /** Remove terrain inside the passage, while preserving the common socle. */
  cutter: Manifold;
  /** Dimensions are measured; the missing spring-line curvature is approximate. */
  approximateProfile: true;
}

/**
 * Reconstruct a documented basket-handle arch from measured span and clearance.
 * An elliptical profile preserves those dimensions; the exact three-centre
 * spring geometry cannot be inferred from a bridge classification alone.
 */
export function makeSurveyedArch(
  cad: ManifoldToplevel,
  owner: Handles,
  options: SurveyedArchOptions,
): SurveyedArch | null {
  const {
    center,
    axis,
    spanMm,
    clearanceMm,
    groundZ,
    deckZ,
    foundationZ,
    minThicknessMm,
  } = options;
  if (
    options.profile !== "basket-handle" ||
    ![
      ...center,
      ...axis,
      spanMm,
      clearanceMm,
      groundZ,
      deckZ,
      foundationZ,
      minThicknessMm,
    ].every(Number.isFinite) ||
    spanMm <= 0 ||
    clearanceMm <= 0 ||
    minThicknessMm <= 0 ||
    groundZ < foundationZ ||
    deckZ < groundZ + clearanceMm + minThicknessMm ||
    options.footprint.isEmpty()
  )
    return null;
  const norm = Math.hypot(...axis);
  if (norm < 0.000001) return null;
  const direction: Point2D = [axis[0] / norm, axis[1] / norm];
  const bounds = options.footprint.bounds();
  const width =
    Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) +
    2;
  const temporary: { delete(): void }[] = [];
  const arena: Handles = {
    keep(handle) {
      temporary.push(handle);
      return handle;
    },
  };
  const outputs = new Set<{ delete(): void }>();
  try {
    const section = arena.keep(options.footprint.intersect(options.clip));
    if (section.isEmpty()) return null;
    const block = arena.keep(
      arena
        .keep(section.extrude(deckZ - foundationZ))
        .translate([0, 0, foundationZ]),
    );
    const half = spanMm / 2;
    const profile: Point2D[] = [
      [-half, foundationZ - 0.02],
      [half, foundationZ - 0.02],
      [half, groundZ],
    ];
    // The upper curve is measured in height and width; use enough facets that
    // the chord error stays far below the 0.12 mm printable stair threshold.
    const facets = Math.max(16, Math.min(96, Math.ceil(spanMm / 0.15)));
    for (let i = 1; i <= facets; i++) {
      const theta = (i / facets) * Math.PI;
      profile.push([
        half * Math.cos(theta),
        groundZ + clearanceMm * Math.sin(theta),
      ]);
    }
    // Local XY becomes world (span,Z), extrusion becomes the transverse axis.
    const passage = arena.keep(
      arena
        .keep(
          arena.keep(new cad.CrossSection([profile], "NonZero")).extrude(width),
        )
        .warp((vertex) => {
          const along = vertex[0],
            vertical = vertex[1],
            across = vertex[2] - width / 2;
          vertex[0] = center[0] + along * direction[0] + across * direction[1];
          vertex[1] = center[1] + along * direction[1] - across * direction[0];
          vertex[2] = vertical;
        }),
    );
    const solid = arena.keep(block.subtract(passage));
    if (solid.status() !== "NoError" || solid.isEmpty()) return null;
    // Keep the surveyed underpass floor at groundZ. Cutting down to the common
    // foundation would artificially increase the documented clear height.
    const aboveGround = arena.keep(passage.trimByPlane([0, 0, 1], groundZ));
    const cutter = arena.keep(aboveGround.intersect(block));
    if (cutter.isEmpty()) return null;
    // Both spring supports must exist; an arbitrary axis through an outline must
    // not leave an isolated crown with no genuine foundations on either side.
    const lower = arena.keep(
      solid.trimByPlane([0, 0, -1], -(groundZ + 0.0001)),
    );
    const feet = lower.decompose().map((foot) => arena.keep(foot));
    if (feet.length < 2) return null;
    for (const handle of [solid, cutter]) {
      outputs.add(handle);
      owner.keep(handle);
    }
    return { solid, cutter, approximateProfile: true };
  } catch {
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (!outputs.has(temporary[i])) temporary[i].delete();
  }
}
