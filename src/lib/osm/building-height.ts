import {
  DEFAULT_BUILDING_HEIGHTS,
  DEFAULT_ROOF_HEIGHT_RATIO,
} from "../constants";
import type { RoofShape } from "../constants";
import type { FootprintClassification } from "../polygon/footprint-classify";
import { orientedFootprintBounds } from "../polygon/footprint-classify";
import type { Point2D } from "@/types/geometry";

/** OSM lengths are metres by default; support decimal commas and feet explicitly. */
export function parseLengthMeters(value?: string): number | null {
  if (!value) return null;
  const match = value
    .trim()
    .replace(",", ".")
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|metres?|meters?|ft|feet|')?$/i);
  if (!match) return null;
  const meters =
    Number(match[1]) * (/^(ft|feet|')$/i.test(match[2] ?? "") ? 0.3048 : 1);
  return meters > 0 && meters < 1000 ? meters : null;
}

/**
 * Read building height from OSM/IGN tags, with a labelled type-based fallback.
 *
 * Priority:
 * 1. Explicit height/building:height tag (meters)
 * 2. building:levels × 3m per level
 * 3. Conservative type-based default
 */
export function getBuildingHeight(
  tags: Record<string, string>,
  _footprintAreaM2?: number,
): number {
  // Keep the optional footprint argument for callers; area is not height evidence.
  void _footprintAreaM2;
  // 1. Explicit height tags
  if (tags["height"]) {
    const h = parseLengthMeters(tags["height"]);
    if (h != null) return h;
  }

  if (tags["building:height"]) {
    const h = parseLengthMeters(tags["building:height"]);
    if (h != null) return h;
  }

  // 2. Level-based height
  if (tags["building:levels"]) {
    const levels = parseFloat(tags["building:levels"]);
    const roofLevels = parseFloat(tags["roof:levels"]);
    if (Number.isFinite(levels) && levels > 0)
      return (
        (levels +
          (Number.isFinite(roofLevels) && roofLevels > 0 ? roofLevels : 0)) *
        3
      );
  }

  // Unknown height stays a conservative, clearly labelled estimate. A wide
  // footprint alone is not evidence of a taller building.
  return DEFAULT_BUILDING_HEIGHTS[tags["building"] ?? "yes"] ?? 9;
}

/**
 * Compute the real-world area of a building footprint in m².
 * Takes projected+scaled points and converts back using the scale factor.
 */
export function computeFootprintAreaM2(
  outerRing: Point2D[],
  scaleFactor: number,
): number {
  if (outerRing.length < 3) return 0;

  // Shoelace formula for polygon area (in scaled units)
  let area = 0;
  for (let i = 0; i < outerRing.length; i++) {
    const j = (i + 1) % outerRing.length;
    area += outerRing[i][0] * outerRing[j][1];
    area -= outerRing[j][0] * outerRing[i][1];
  }
  area = Math.abs(area) / 2;

  // Convert from scaled mm² back to m²
  // scaleFactor = 1000/scale, so 1 scaled unit = scale/1000 meters
  // area in m² = area_scaled × (scale/1000)²
  const metersPerUnit = 1 / scaleFactor; // = scale / 1000
  return area * metersPerUnit * metersPerUnit;
}

const ROOF_SHAPE_MAP: Record<string, RoofShape> = {
  flat: "flat",
  gabled: "gabled",
  hipped: "hipped",
  pyramidal: "pyramidal",
  skillion: "skillion",
  dome: "dome",
  cone: "cone",
  onion: "onion",
  round: "round",
  "half-hipped": "half-hipped",
  gambrel: "gambrel",
  saltbox: "saltbox",
  mansard: "mansard",
  pitched: "gabled",
};

export function getRoofShape(
  tags: Record<string, string>,
  _hasHoles: boolean,
  _classification: FootprintClassification,
): RoofShape {
  void _hasHoles;
  void _classification;
  // Footprint complexity is not evidence of a different roof shape. The solid
  // generator clips the roof envelope to the complete footprint, including holes.
  return ROOF_SHAPE_MAP[tags["roof:shape"]?.trim().toLowerCase()] ?? "flat";
}

const COMPASS_BEARINGS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/** Bearing denotes runoff, clockwise from north, rather than the ridge direction. */
export function roofDirection(tags: Record<string, string>): Point2D | null {
  const value = tags["roof:direction"]?.trim().toUpperCase();
  if (!value) return null;
  const bearing =
    COMPASS_BEARINGS[value] ??
    (/^[+-]?\d+(?:[.,]\d+)?(?:°)?$/.test(value)
      ? Number(value.replace(",", ".").replace("°", ""))
      : NaN);
  if (!Number.isFinite(bearing)) return null;
  const radians = (bearing * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians)];
}

export function roofRidgeAxis(
  tags: Record<string, string>,
  classification: FootprintClassification,
): Point2D {
  const downhill = roofDirection(tags);
  if (downhill) return [-downhill[1], downhill[0]];
  const axis = classification.dominantAxis;
  return tags["roof:orientation"]?.trim().toLowerCase() === "across"
    ? [-axis[1], axis[0]]
    : axis;
}

export interface RoofFootprint {
  points: Point2D[];
  classification: FootprintClassification;
  scaleFactor: number;
}

export function getRoofHeight(
  tags: Record<string, string>,
  totalHeight: number,
  roofShape: RoofShape,
  footprint?: RoofFootprint,
): number {
  if (roofShape === "flat") return 0;

  if (tags["roof:height"]) {
    if (/^0(?:[.,]0+)?(?:\s*m)?$/.test(tags["roof:height"].trim())) return 0;
    const h = parseLengthMeters(tags["roof:height"]);
    if (h != null) return Math.min(h, totalHeight);
  }

  if (tags["roof:levels"]) {
    const levels = Number(tags["roof:levels"].replace(",", "."));
    if (Number.isFinite(levels) && levels > 0)
      return Math.min(levels * 3, totalHeight);
  }

  if (
    footprint &&
    ["gabled", "hipped", "pyramidal", "skillion", "half-hipped"].includes(
      roofShape,
    )
  ) {
    const angle = Number(tags["roof:angle"]?.replace(",", "."));
    if (Number.isFinite(angle) && angle > 0 && angle < 85) {
      const bounds = orientedFootprintBounds(
        footprint.points,
        roofRidgeAxis(tags, footprint.classification),
      );
      const run =
        (bounds.maxAcross - bounds.minAcross) /
        footprint.scaleFactor /
        (roofShape === "skillion" ? 1 : 2);
      return Math.min(run * Math.tan((angle * Math.PI) / 180), totalHeight);
    }
  }

  return totalHeight * DEFAULT_ROOF_HEIGHT_RATIO[roofShape];
}
