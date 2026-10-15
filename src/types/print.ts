import type { BBox, DataReport, ElevationGrid, OverpassResponse } from "./osm";
import type { ModelSettings } from "@/store/use-scene-store";

/** Coordinates are millimetres, with east +X, north +Y and vertical +Z. */
export const PRINT_LAYERS = [
  "basePlate",
  "buildings",
  "roads",
  "water",
  "parks",
  "sand",
  "piers",
  "frame",
] as const;
export type PrintLayer = (typeof PRINT_LAYERS)[number];

export interface PrintMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** One entry per triangle, indexing PRINT_LAYERS. */
  faceLayers: Uint8Array;
}

export interface PrintTile extends PrintMesh {
  col: number;
  row: number;
  widthMm: number;
  depthMm: number;
}

export interface PrintedLandmark {
  id: string;
  name: string;
  /** Bounds of the retained solid, in the printable model coordinate system. */
  min: [number, number, number];
  max: [number, number, number];
  representation:
    | "surveyed-solid"
    | "surveyed-roof"
    | "lidar-roof"
    | "osm-roof"
    | "footprint";
  source: string;
}

export interface PrintModel extends PrintMesh {
  plateSizeMm?: 100 | 150;
  /** Only landmarks actually retained by the printable geometry pipeline. */
  landmarks?: PrintedLandmark[];
  colors: Record<PrintLayer, string>;
  dimensions: { widthMm: number; depthMm: number; heightMm: number };
  stats: {
    buildingCount: number;
    roadCount: number;
    waterCount: number;
    parkCount: number;
    sandCount: number;
    pierCount: number;
    discardedFeatures: number;
    triangleCount: number;
    components: number;
    volumeMm3: number;
    estimatedHeights: number;
    realRoofCount: number;
    /** Reconstructed from IGN MNS/MNT; not a measured LoD2 building geometry. */
    lidarRoofCount?: number;
    taggedRoofCount: number;
    staircaseCount: number;
    measuredStructureCount: number;
    reconstructedBridgeCount: number;
    basinRimCount: number;
    reconstructedAqueductCount: number;
    aqueductArchCount: number;
  };
  warnings: string[];
  sources: string[];
  fetchedAt: string;
  osmTimestamp?: string;
  /** Real, closed intersections with the requested tile grid, each resting at Z=0. */
  tiles: PrintTile[];
}

export interface PrintInput {
  osmData: OverpassResponse;
  bbox: BBox;
  scale: number;
  elevationGrid: ElevationGrid | null;
  settings: ModelSettings;
  report?: DataReport | null;
}

export type PrintProgress = (progress: number, label: string) => void;

export interface BuildWorkerRequest {
  type: "build";
  id: number;
  input: PrintInput;
}
export type BuildWorkerResponse =
  | { type: "progress"; id: number; progress: number; label: string }
  | { type: "success"; id: number; model: PrintModel }
  | { type: "error"; id: number; message: string };
