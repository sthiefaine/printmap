export const FEATURE_LAYERS = {
  buildings: { color: "#D4D4D4", hex: 0xd4d4d4, name: "Bâtiments" },
  roads: { color: "#555555", hex: 0x555555, name: "Routes" },
  water: { color: "#4A90D9", hex: 0x4a90d9, name: "Eau" },
  parks: { color: "#6AB04C", hex: 0x6ab04c, name: "Parcs" },
  sand: { color: "#F4E4B0", hex: 0xf4e4b0, name: "Sable" },
  piers: { color: "#A0856C", hex: 0xa0856c, name: "Pontons" },
  basePlate: { color: "#999999", hex: 0x999999, name: "Socle" },
} as const;

export type FeatureLayer = keyof typeof FEATURE_LAYERS;

export const DEFAULT_BUILDING_HEIGHTS: Record<string, number> = {
  house: 8,
  detached: 8,
  semidetached_house: 8,
  terrace: 9,
  residential: 12,
  apartments: 18,
  commercial: 15,
  industrial: 10,
  church: 20,
  cathedral: 30,
  chapel: 12,
  retail: 12,
  office: 20,
  hospital: 15,
  school: 12,
  university: 15,
  hotel: 20,
  warehouse: 8,
  garage: 3,
  garages: 3,
  shed: 3,
  barn: 8,
  farm: 7,
  roof: 3,
  kiosk: 3,
  cabin: 5,
  hut: 3,
  civic: 15,
  public: 15,
  train_station: 12,
  parking: 9,
  supermarket: 8,
  yes: 9,
};

export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 12,
  trunk: 10,
  primary: 10,
  secondary: 8,
  tertiary: 6,
  residential: 5,
  service: 3,
  footway: 2,
  path: 1.5,
  cycleway: 2,
  pedestrian: 4,
  unclassified: 5,
};

export const WATERWAY_WIDTHS: Record<string, number> = {
  river: 15,
  canal: 10,
  stream: 4,
  drain: 3,
  ditch: 2,
};

export type RoofShape =
  | "flat"
  | "gabled"
  | "hipped"
  | "pyramidal"
  | "skillion"
  | "dome"
  | "cone"
  | "round"
  | "onion"
  | "mansard"
  | "gambrel"
  | "saltbox"
  | "half-hipped";

export const DEFAULT_ROOF_HEIGHT_RATIO: Record<RoofShape, number> = {
  flat: 0,
  gabled: 0.35,
  hipped: 0.3,
  pyramidal: 0.4,
  skillion: 0.25,
  dome: 0.35,
  cone: 0.4,
  round: 0.3,
  onion: 0.5,
  mansard: 0.35,
  gambrel: 0.35,
  saltbox: 0.35,
  "half-hipped": 0.3,
};

export const DEFAULT_SCALE = 5000;
export const TILE_SIZE_MM = 200;
export const BASE_PLATE_THICKNESS_MM = 2;
export const ROAD_EXTRUSION_MM = 0.6;
export const WATER_HEIGHT_MM = 0.2;
export const PARK_HEIGHT_MM = 0.4;
export const SAND_HEIGHT_MM = 0.3;
export const PIER_HEIGHT_MM = 0.8;

// Footprint classification thresholds
// Lowered to allow more buildings to get non-flat roofs (like OSM Buildings)
export const RECTANGULARITY_THRESHOLD = 0.8;
export const CONVEXITY_THRESHOLD = 0.75;
export const MAX_RECTANGULAR_VERTICES = 8;

// Per-layer Z offsets (mm) above terrain surface — prevents z-fighting
export const LAYER_Z_OFFSETS = {
  water: 0.0,
  sand: 0.02,
  parks: 0.04,
  roads: 0.06,
  piers: 0.08,
  buildings: 0.1,
} as const;

// Elevation / terrain
export const ELEVATION_GRID_RESOLUTION = 30;
export const ELEVATION_EXAGGERATION = 1.0;

export const SCALE_OPTIONS = [
  { value: 1000, label: "1:1 000" },
  { value: 2500, label: "1:2 500" },
  { value: 5000, label: "1:5 000" },
  { value: 10000, label: "1:10 000" },
  { value: 25000, label: "1:25 000" },
];
