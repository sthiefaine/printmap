import type { BBox } from "@/types/osm";
import type { ModelSettings } from "@/store/use-scene-store";
import { getBboxDimensions } from "./mesh/base-plate-mesh";

export const SAINT_ETIENNE_STADIUM_BBOX: BBox = [
  45.4288, 4.3702, 45.4628, 4.406,
];

export interface SalonPrintLayout {
  count: 2 | 4 | 6 | 9;
  grid: { cols: number; rows: number };
  widthMm: number;
  heightMm: number;
  tileWidthMm: number;
  tileHeightMm: number;
  longSideMm: number;
  scale: number;
}

/** Preserve the selected geography and fit every tile on a 150 mm bed, with
 * 5 mm reserved beyond the model in each dimension. The size is that of the
 * assembled model; adding tiles without enlarging it would add no detail. */
export function salonPrintLayouts(bbox: BBox): SalonPrintLayout[] {
  if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3])
    throw new Error("La zone du format d’impression est invalide.");
  const geographic = getBboxDimensions(bbox, 1000);
  const twoAcross = Math.min(
    (2 * 145) / geographic.widthMm,
    145 / geographic.heightMm,
  );
  const twoAlong = Math.min(
    145 / geographic.widthMm,
    (2 * 145) / geographic.heightMm,
  );
  // Pick the two-tile orientation that gives the largest physical model,
  // rather than stretching the selection to fill a fixed arrangement.
  const two =
    twoAcross > twoAlong
      ? ({ count: 2, cols: 2, rows: 1 } as const)
      : ({ count: 2, cols: 1, rows: 2 } as const);
  const grids = [
    two,
    { count: 4, cols: 2, rows: 2 },
    { count: 6, cols: 2, rows: 3 },
    { count: 9, cols: 3, rows: 3 },
  ] as const;
  return grids.map(({ count, cols, rows }) => {
    const factor = Math.min(
      (cols * 145) / geographic.widthMm,
      (rows * 145) / geographic.heightMm,
    );
    const widthMm = geographic.widthMm * factor;
    const heightMm = geographic.heightMm * factor;
    return {
      count,
      grid: { cols, rows },
      widthMm,
      heightMm,
      tileWidthMm: widthMm / cols,
      tileHeightMm: heightMm / rows,
      longSideMm: Math.max(widthMm, heightMm),
      scale: 1000 / factor,
    };
  });
}

export function salonLayoutDimensions(layout: SalonPrintLayout): string {
  const mm = (value: number) =>
    value.toLocaleString("fr-FR", {
      maximumFractionDigits: 1,
    });
  return `${layout.count} plaques : taille réelle assemblée ${mm(layout.widthMm)} × ${mm(layout.heightMm)} mm ; chaque plaque ${mm(layout.tileWidthMm)} × ${mm(layout.tileHeightMm)} mm.`;
}

/** Selecting a physical format uses the same horizontal and vertical scale.
 * Existing colours, printing thresholds and geographic data are retained. */
export function salonLayoutSettings(
  settings: ModelSettings,
  layout: SalonPrintLayout,
): ModelSettings {
  return {
    ...settings,
    base: {
      ...settings.base,
      grid: { ...layout.grid },
      topographyEnabled: true,
      elevationExaggeration: 1,
    },
    features: {
      ...settings.features,
      buildings: {
        ...settings.features.buildings,
        buildingScale: 1,
        roofs: true,
      },
    },
  };
}
