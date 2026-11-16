/** OSM lengths are metres by default; support decimal commas and feet. */
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

const DEFAULT_HEIGHTS: Record<string, number> = {
  house: 7,
  detached: 7,
  semidetached_house: 7,
  bungalow: 4,
  terrace: 8,
  residential: 10,
  apartments: 16,
  commercial: 12,
  industrial: 9,
  retail: 8,
  office: 18,
  hotel: 18,
  hospital: 15,
  school: 10,
  university: 14,
  church: 18,
  cathedral: 30,
  chapel: 10,
  warehouse: 8,
  garage: 3,
  garages: 3,
  shed: 3,
  hut: 3,
  roof: 4,
  kiosk: 3,
  greenhouse: 3,
  civic: 14,
  public: 14,
  train_station: 12,
  parking: 9,
  supermarket: 7,
};

/** Height in metres and whether it comes from actual data or a type-based
 * guess. `includesRoof` tells whether that height reaches the top of the roof
 * (OSM `height`) or stops at the top of the walls. */
export function buildingHeight(tags: Record<string, string>): {
  height: number;
  estimated: boolean;
  includesRoof: boolean;
} {
  const explicit =
    parseLengthMeters(tags.height) ??
    parseLengthMeters(tags["building:height"]);
  if (explicit != null)
    return { height: explicit, estimated: false, includesRoof: true };
  const levels = parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0) {
    const roofLevels = parseFloat(tags["roof:levels"] ?? "");
    return {
      height: (levels + (roofLevels > 0 ? roofLevels : 0)) * 3 + 1,
      estimated: false,
      includesRoof: roofLevels > 0,
    };
  }
  // Height carried by vector tiles: whole metres derived from the same tags.
  const tiled = parseLengthMeters(tags["printmap:tile_height"]);
  if (tiled != null)
    return { height: tiled, estimated: false, includesRoof: false };
  const kind = tags.building ?? tags["building:part"] ?? "yes";
  return {
    height: DEFAULT_HEIGHTS[kind] ?? 9,
    estimated: true,
    includesRoof: false,
  };
}

export type RoofShape =
  "gabled" | "hipped" | "pyramidal" | "skillion" | "dome" | "cone";
export interface Roof {
  shape: RoofShape;
  /** Tagged height in metres, when OSM gives one. */
  heightM: number | null;
  /** Compass bearing the main slope faces, in degrees clockwise from north. */
  direction: number | null;
  /** Ridge across the long side instead of along it. */
  across: boolean;
}

// Shapes without a model of their own use the closest printable silhouette.
const ROOF_SHAPES: Record<string, RoofShape> = {
  gabled: "gabled",
  pitched: "gabled",
  "half-hipped": "gabled",
  gambrel: "gabled",
  saltbox: "gabled",
  round: "gabled",
  hipped: "hipped",
  mansard: "hipped",
  pyramidal: "pyramidal",
  skillion: "skillion",
  lean_to: "skillion",
  dome: "dome",
  onion: "dome",
  cone: "cone",
};
const CARDINALS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** A sloped roof described by OSM tags, or null for flat and unknown roofs. */
export function roofFromTags(tags: Record<string, string>): Roof | null {
  const shape = ROOF_SHAPES[tags["roof:shape"] ?? ""];
  if (!shape) return null;
  const levels = parseFloat(tags["roof:levels"] ?? "");
  const raw = (tags["roof:direction"] ?? "").trim().toUpperCase();
  const cardinal = CARDINALS.indexOf(raw);
  const bearing = cardinal >= 0 ? cardinal * 22.5 : parseFloat(raw);
  return {
    shape,
    heightM:
      parseLengthMeters(tags["roof:height"]) ??
      (levels > 0 ? levels * 3 : null),
    direction: Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : null,
    across: tags["roof:orientation"] === "across",
  };
}
