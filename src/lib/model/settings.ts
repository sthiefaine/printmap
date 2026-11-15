export const LAYERS = ["base", "roads", "water", "green", "buildings"] as const;
export type LayerId = (typeof LAYERS)[number];

export const LAYER_NAMES: Record<LayerId, string> = {
  base: "Socle",
  roads: "Routes",
  water: "Eau",
  green: "Espaces verts",
  buildings: "Bâtiments",
};

export type RoadLevel = "major" | "streets" | "all";

export interface ModelSettings {
  /** "grid": fill cols × rows plates. "custom": fixed size, plates computed. */
  sizeMode: "grid" | "custom";
  cols: number;
  rows: number;
  /** Long side of the assembled model, used in "custom" mode. */
  longSideMm: number;
  /** Printer bed. A 5 mm margin is kept on every side. */
  bedWidthMm: number;
  bedDepthMm: number;
  baseMm: number;
  relief: boolean;
  reliefScale: number;
  buildings: boolean;
  buildingScale: number;
  roads: boolean;
  roadLevel: RoadLevel;
  roadWidthScale: number;
  /** Offsets from the ground surface: negative engraves, positive raises. */
  roadOffsetMm: number;
  water: boolean;
  waterOffsetMm: number;
  green: boolean;
  greenOffsetMm: number;
  /** Smallest printable detail, roughly two nozzle widths. */
  minFeatureMm: number;
  /** Bow-tie key pockets under the seams between plates. */
  connectors: boolean;
  /** Column-row number engraved under each plate. */
  labels: boolean;
  colors: Record<LayerId, string>;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  sizeMode: "grid",
  cols: 1,
  rows: 1,
  longSideMm: 200,
  bedWidthMm: 256,
  bedDepthMm: 256,
  baseMm: 3,
  relief: false,
  reliefScale: 1,
  buildings: true,
  buildingScale: 1,
  roads: true,
  roadLevel: "streets",
  roadWidthScale: 1,
  roadOffsetMm: -0.4,
  water: true,
  waterOffsetMm: -0.8,
  green: true,
  greenOffsetMm: 0.2,
  minFeatureMm: 0.8,
  connectors: true,
  labels: true,
  colors: {
    base: "#d9d4c7",
    roads: "#8b8b8b",
    water: "#5b9bd5",
    green: "#7fb069",
    buildings: "#f4f1ea",
  },
};

export const BED_PRESETS = [
  { name: "150 × 150", w: 150, d: 150 },
  { name: "180 × 180 (A1 mini, Prusa Mini)", w: 180, d: 180 },
  { name: "220 × 220 (Ender 3, Kobra)", w: 220, d: 220 },
  { name: "250 × 210 (Prusa MK4)", w: 250, d: 210 },
  { name: "256 × 256 (Bambu A1, P1, X1)", w: 256, d: 256 },
  { name: "300 × 300", w: 300, d: 300 },
  { name: "350 × 350", w: 350, d: 350 },
];

export const BED_MARGIN_MM = 5;
export const MAX_PLATES_PER_SIDE = 12;
export const MAX_MODEL_MM = 3000;

export interface Layout {
  widthMm: number;
  depthMm: number;
  cols: number;
  rows: number;
  tileWidthMm: number;
  tileDepthMm: number;
  /** Printed millimetres per real metre. */
  mmPerM: number;
  /** The N of 1:N. */
  scale: number;
}

const clampInt = (value: number, min: number, max: number) =>
  Math.min(
    max,
    Math.max(min, Math.round(Number.isFinite(value) ? value : min)),
  );

/** Size of the assembled model and of its equal plates, for a real-world
 * rectangle of widthM × heightM. The bed may be used in either orientation. */
export function computeLayout(
  widthM: number,
  heightM: number,
  settings: Pick<
    ModelSettings,
    "sizeMode" | "cols" | "rows" | "longSideMm" | "bedWidthMm" | "bedDepthMm"
  >,
): Layout {
  const usableW = Math.max(20, settings.bedWidthMm - 2 * BED_MARGIN_MM);
  const usableD = Math.max(20, settings.bedDepthMm - 2 * BED_MARGIN_MM);
  const orientations =
    usableW === usableD
      ? [[usableW, usableD]]
      : [
          [usableW, usableD],
          [usableD, usableW],
        ];
  let best: Layout | null = null;
  for (const [maxW, maxD] of orientations) {
    let cols: number, rows: number, mmPerM: number;
    if (settings.sizeMode === "grid") {
      cols = clampInt(settings.cols, 1, MAX_PLATES_PER_SIDE);
      rows = clampInt(settings.rows, 1, MAX_PLATES_PER_SIDE);
      mmPerM = Math.min((cols * maxW) / widthM, (rows * maxD) / heightM);
    } else {
      const longSide = Math.min(
        MAX_MODEL_MM,
        Math.max(20, settings.longSideMm || 20),
      );
      mmPerM = longSide / Math.max(widthM, heightM);
      cols = Math.max(1, Math.ceil((widthM * mmPerM) / maxW - 1e-9));
      rows = Math.max(1, Math.ceil((heightM * mmPerM) / maxD - 1e-9));
    }
    const widthMm = widthM * mmPerM,
      depthMm = heightM * mmPerM;
    const candidate: Layout = {
      widthMm,
      depthMm,
      cols,
      rows,
      tileWidthMm: widthMm / cols,
      tileDepthMm: depthMm / rows,
      mmPerM,
      scale: 1000 / mmPerM,
    };
    const better =
      !best ||
      (settings.sizeMode === "grid"
        ? candidate.mmPerM > best.mmPerM + 1e-12
        : candidate.cols * candidate.rows < best.cols * best.rows);
    if (better) best = candidate;
  }
  return best!;
}

export function tileLabel(col: number, row: number) {
  return `${col + 1}-${row + 1}`;
}
