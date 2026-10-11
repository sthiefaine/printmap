import {
  DEFAULT_BUILDING_HEIGHTS,
  DEFAULT_ROOF_HEIGHT_RATIO,
} from "../constants";
import type { RoofShape } from "../constants";
import type { FootprintClassification } from "../polygon/footprint-classify";
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
    if (!isNaN(levels) && levels > 0) return levels * 3;
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
  dome: "pyramidal",
  onion: "pyramidal",
  round: "pyramidal",
  "half-hipped": "hipped",
  gambrel: "gabled",
  saltbox: "gabled",
  mansard: "hipped",
};

function applyClassificationOverride(
  requested: RoofShape,
  classification: FootprintClassification,
): RoofShape {
  const { footprintClass, convexity } = classification;

  if (footprintClass === "complex") {
    // Only force flat for truly irregular buildings (very low convexity)
    // Buildings with moderate convexity (L-shapes, T-shapes) can still
    // have hipped roofs — this matches OSM Buildings behavior
    if (convexity < 0.55) return "flat";
    // Moderately complex → hipped is safest (works on most shapes)
    if (requested === "gabled") return "hipped";
    if (requested === "pyramidal") return "hipped";
    return requested;
  }

  if (footprintClass === "convex-simple") {
    // Gabled works poorly on non-rectangular shapes → use hipped
    if (requested === "gabled") return "hipped";
    return requested;
  }

  // Rectangular: all roof shapes work fine
  return requested;
}

export function getRoofShape(
  tags: Record<string, string>,
  hasHoles: boolean,
  classification: FootprintClassification,
): RoofShape {
  if (hasHoles) return "flat";

  let requested: RoofShape;
  const osmShape = tags["roof:shape"];
  if (osmShape) {
    requested = ROOF_SHAPE_MAP[osmShape] ?? "flat";
  } else {
    requested = "flat";
  }

  return applyClassificationOverride(requested, classification);
}

export function getRoofHeight(
  tags: Record<string, string>,
  totalHeight: number,
  roofShape: RoofShape,
): number {
  if (roofShape === "flat") return 0;

  if (tags["roof:height"]) {
    const h = parseLengthMeters(tags["roof:height"]);
    if (h != null) return Math.min(h, totalHeight * 0.6);
  }

  if (tags["roof:levels"]) {
    const levels = parseInt(tags["roof:levels"], 10);
    if (!isNaN(levels)) return Math.min(levels * 1.5, totalHeight * 0.6);
  }

  return totalHeight * DEFAULT_ROOF_HEIGHT_RATIO[roofShape];
}
