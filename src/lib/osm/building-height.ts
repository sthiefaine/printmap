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

/** Height in metres and whether it comes from actual data or a type-based guess. */
export function buildingHeight(tags: Record<string, string>): {
  height: number;
  estimated: boolean;
} {
  const explicit =
    parseLengthMeters(tags.height) ??
    parseLengthMeters(tags["building:height"]);
  if (explicit != null) return { height: explicit, estimated: false };
  const levels = parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0) {
    const roofLevels = parseFloat(tags["roof:levels"] ?? "");
    return {
      height: (levels + (roofLevels > 0 ? roofLevels : 0)) * 3 + 1,
      estimated: false,
    };
  }
  // Height carried by vector tiles: whole metres derived from the same tags.
  const tiled = parseLengthMeters(tags["printmap:tile_height"]);
  if (tiled != null) return { height: tiled, estimated: false };
  const kind = tags.building ?? tags["building:part"] ?? "yes";
  return { height: DEFAULT_HEIGHTS[kind] ?? 9, estimated: true };
}
