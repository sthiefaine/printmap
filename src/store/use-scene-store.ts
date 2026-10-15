import { create } from "zustand";
import type * as GeoJSON from "geojson";
import type {
  BBox,
  OverpassResponse,
  ElevationGrid,
  DataReport,
} from "@/types/osm";
import { validateElevationGrid } from "@/lib/elevation/validate-grid";
import { validateBbox } from "@/lib/data/bbox";
import { validateRoofData } from "@/lib/data/validate-roofs";
import { validateImportedElements } from "@/lib/data/validate-imported-elements";
import { getBboxDimensions } from "@/lib/mesh/base-plate-mesh";
import { validPrintGrid, type PlateSizeMm } from "@/lib/plate-layout";

export interface FrameSettings {
  enabled: boolean;
  rounded: boolean;
  heightMm: number;
  thicknessMm: number;
  color: string;
  textEnabled: boolean;
  text: string;
  textSizeMm: number;
  textHeightMm: number;
  textColor: string;
}
export interface GridSettings {
  cols: number;
  rows: number;
}
export interface BaseSettings {
  basePlateThicknessMm: number;
  baseColor: string;
  topographyEnabled: boolean;
  elevationExaggeration: number;
  dataSource: "osm" | "overture" | "osmbuildings";
  frame: FrameSettings;
  grid: GridSettings;
  plateSizeMm?: PlateSizeMm | null;
}
export interface BuildingSettings {
  enabled: boolean;
  color: string;
  roofColor: string;
  osmColors: boolean;
  roofs: boolean;
  buildingScale: number;
  minHeightM: number;
  minAreaM2: number;
  windows: boolean;
  windowMode: "color" | "geometry";
  windowColor: string;
  windowRecessMm: number;
  forceBasicShape: boolean;
}
export type RoadFilter = "all" | "minor" | "major";
export interface RoadSettings {
  enabled: boolean;
  color: string;
  heightMm: number;
  widthMultiplier: number;
  filter: RoadFilter;
  roadDepthMm: number;
  footpathsEnabled: boolean;
  undergroundRoadsEnabled: boolean;
  roadTypeEnabled: Record<string, boolean>;
}
export interface WaterSettings {
  enabled: boolean;
  color: string;
  heightMm: number;
  minAreaM2: number;
  waterCutout: boolean;
  oceanEnabled: boolean;
  waterBaseEnabled: boolean;
  waterBaseHeightMm: number;
  waterDepthMm: number;
}
export interface SimpleFeatureSettings {
  enabled: boolean;
  color: string;
  heightMm: number;
}
export interface GpxSettings extends SimpleFeatureSettings {
  widthMeters: number;
  geoJSON: GeoJSON.LineString | null;
}
export interface FeatureSettings {
  buildings: BuildingSettings;
  roads: RoadSettings;
  water: WaterSettings;
  parks: SimpleFeatureSettings;
  sand: SimpleFeatureSettings;
  piers: SimpleFeatureSettings;
  gpx: GpxSettings;
}
export interface PrintSettings {
  minFeatureMm: number;
  minBuildingAreaMm2: number;
  minBuildingHeightMm: number;
  simplifyMm: number;
}
export interface ModelSettings {
  base: BaseSettings;
  features: FeatureSettings;
  print: PrintSettings;
}
export type PrintProfile = "clean" | "balanced" | "detail";

export const PRINT_PROFILES: Record<
  PrintProfile,
  { label: string; hint: string; print: PrintSettings; roads: RoadFilter }
> = {
  clean: {
    label: "Épuré",
    hint: "Grands volumes, lecture immédiate",
    print: {
      minFeatureMm: 1,
      minBuildingAreaMm2: 2,
      minBuildingHeightMm: 0.8,
      simplifyMm: 0.2,
    },
    roads: "major",
  },
  balanced: {
    label: "Équilibré",
    hint: "Quartiers lisibles, détails utiles",
    print: {
      minFeatureMm: 0.8,
      minBuildingAreaMm2: 1.2,
      minBuildingHeightMm: 0.6,
      simplifyMm: 0.12,
    },
    roads: "minor",
  },
  detail: {
    label: "Détaillé",
    hint: "Petites empreintes et chemins",
    print: {
      minFeatureMm: 0.45,
      minBuildingAreaMm2: 0.4,
      minBuildingHeightMm: 0.35,
      simplifyMm: 0.06,
    },
    roads: "all",
  },
};

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  print: { ...PRINT_PROFILES.balanced.print },
  base: {
    basePlateThicknessMm: 3,
    baseColor: "#e8e3d7",
    topographyEnabled: true,
    elevationExaggeration: 1,
    dataSource: "osm",
    frame: {
      enabled: false,
      rounded: false,
      heightMm: 1.2,
      thicknessMm: 2,
      color: "#b8ab91",
      textEnabled: false,
      text: "",
      textSizeMm: 6,
      textHeightMm: 0.8,
      textColor: "#000000",
    },
    grid: { cols: 1, rows: 1 },
  },
  features: {
    buildings: {
      enabled: true,
      color: "#e4dccb",
      roofColor: "#e4dccb",
      osmColors: false,
      roofs: true,
      buildingScale: 1,
      minHeightM: 0,
      minAreaM2: 0,
      windows: false,
      windowMode: "color",
      windowColor: "#2c3e50",
      windowRecessMm: 0.3,
      forceBasicShape: false,
    },
    roads: {
      enabled: true,
      color: "#807a6c",
      heightMm: 0,
      widthMultiplier: 1,
      filter: "minor",
      roadDepthMm: 0,
      footpathsEnabled: false,
      undergroundRoadsEnabled: false,
      roadTypeEnabled: {},
    },
    water: {
      enabled: true,
      color: "#479cad",
      heightMm: 0,
      minAreaM2: 0,
      waterCutout: false,
      oceanEnabled: true,
      waterBaseEnabled: false,
      waterBaseHeightMm: 0.2,
      waterDepthMm: 0,
    },
    parks: { enabled: true, color: "#8ca16d", heightMm: 0 },
    sand: { enabled: true, color: "#d7be8c", heightMm: 0 },
    piers: { enabled: true, color: "#a6876d", heightMm: 0.4 },
    gpx: {
      enabled: false,
      color: "#df794c",
      heightMm: 0.5,
      widthMeters: 10,
      geoJSON: null,
    },
  },
};

export interface ProjectSnapshot {
  bbox: BBox | null;
  selectedCity: { name: string; lat: number; lng: number } | null;
  osmData: OverpassResponse | null;
  elevationGrid: ElevationGrid | null;
  report: DataReport | null;
  isDemo: boolean;
}
export interface ProjectFile {
  version: 2;
  name: string;
  timestamp: string;
  settings: ModelSettings;
  scale: number;
  tileSize: number;
  profile: PrintProfile;
  snapshot: ProjectSnapshot;
}

function cloneDefaults(): ModelSettings {
  return structuredClone(DEFAULT_MODEL_SETTINGS);
}
export function normalizeSettings(value: unknown): ModelSettings {
  const defaults = cloneDefaults();
  if (!value || typeof value !== "object")
    throw new Error("Paramètres du projet manquants.");
  const source = value as Partial<ModelSettings>;
  const normalized: ModelSettings = {
    base: {
      ...defaults.base,
      ...source.base,
      frame: {
        ...defaults.base.frame,
        ...source.base?.frame,
        textEnabled: false,
      },
      grid: { ...defaults.base.grid, ...source.base?.grid },
    },
    features: { ...defaults.features },
    print: { ...defaults.print, ...source.print },
  };
  for (const layer of Object.keys(
    defaults.features,
  ) as (keyof FeatureSettings)[]) {
    Object.assign(normalized.features[layer], source.features?.[layer]);
  }
  normalized.features.buildings.windows = false;
  normalized.features.buildings.forceBasicShape = false;
  normalized.features.buildings.osmColors = false;
  normalized.features.gpx.enabled = false;
  normalized.features.roads.roadDepthMm = 0;
  normalized.features.water.waterCutout = false;
  normalized.features.water.waterDepthMm = 0;
  const ranges: [number, number, number][] = [
    [normalized.base.basePlateThicknessMm, 1, 15],
    [normalized.base.elevationExaggeration, 0.5, 5],
    [normalized.print.minFeatureMm, 0.15, 3],
    [normalized.print.minBuildingAreaMm2, 0, 30],
    [normalized.print.minBuildingHeightMm, 0.15, 5],
    [normalized.print.simplifyMm, 0, 1],
    [normalized.base.grid.cols, 1, 25],
    [normalized.base.grid.rows, 1, 25],
    [normalized.features.buildings.buildingScale, 0.5, 3],
    [normalized.features.buildings.minHeightM, 0, 1000],
    [normalized.features.buildings.minAreaM2, 0, 1e6],
    [normalized.features.roads.widthMultiplier, 0.5, 3],
    [normalized.features.water.minAreaM2, 0, 1e6],
    [normalized.base.frame.thicknessMm, 1, 10],
    [normalized.base.frame.heightMm, 0.1, 5],
  ];
  if (ranges.some(([v, min, max]) => !Number.isFinite(v) || v < min || v > max))
    throw new Error("Le projet contient des dimensions invalides.");
  if (!validPrintGrid(normalized.base.grid))
    throw new Error("La grille doit contenir un nombre entier de tuiles.");
  if (
    normalized.base.plateSizeMm != null &&
    ![100, 150].includes(normalized.base.plateSizeMm)
  )
    throw new Error("Le format des plaques est invalide.");
  if (
    typeof normalized.base.topographyEnabled !== "boolean" ||
    typeof normalized.base.frame.enabled !== "boolean" ||
    typeof normalized.features.buildings.roofs !== "boolean"
  )
    throw new Error("Options du projet invalides.");
  if (
    ![
      normalized.base.baseColor,
      normalized.base.frame.color,
      normalized.features.buildings.roofColor,
    ].every(
      (color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
    )
  )
    throw new Error("Couleur du projet invalide.");
  if (!["all", "minor", "major"].includes(normalized.features.roads.filter))
    throw new Error("Filtre routier invalide.");
  const roadTypes = normalized.features.roads.roadTypeEnabled;
  if (
    !roadTypes ||
    typeof roadTypes !== "object" ||
    Array.isArray(roadTypes) ||
    Object.values(roadTypes).some((enabled) => typeof enabled !== "boolean") ||
    typeof normalized.features.roads.footpathsEnabled !== "boolean"
  )
    throw new Error("Options des voies du projet invalides.");
  for (const [layer, settings] of Object.entries(normalized.features)) {
    if (
      typeof settings.enabled !== "boolean" ||
      !/^#[0-9a-f]{6}$/i.test(settings.color)
    )
      throw new Error(`Couche ${layer} invalide.`);
    if (
      "heightMm" in settings &&
      (!Number.isFinite(settings.heightMm) ||
        settings.heightMm <
          (layer === "roads"
            ? -1.2
            : ["water", "parks", "sand"].includes(layer)
              ? -0.8
              : 0.1) ||
        settings.heightMm > 5)
    )
      throw new Error(`Hauteur ${layer} invalide.`);
  }
  return normalized;
}

interface SceneState {
  scale: number;
  tileSize: number;
  profile: PrintProfile;
  modelSettings: ModelSettings;
  setScale: (scale: number) => void;
  setTileSize: (size: number, bbox?: BBox | null) => void;
  fitSelection: (bbox: BBox) => void;
  setProfile: (profile: PrintProfile) => void;
  updatePrintSettings: (partial: Partial<PrintSettings>) => void;
  updateBaseSettings: (partial: Partial<BaseSettings>) => void;
  updateFeatureSettings: <K extends keyof FeatureSettings>(
    layer: K,
    partial: Partial<FeatureSettings[K]>,
  ) => void;
  resetSettings: () => void;
  saveProject: (snapshot: ProjectSnapshot, name?: string) => string;
  loadProject: (json: string) => ProjectSnapshot | null;
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scale: 5000,
  tileSize: 200,
  profile: "balanced",
  modelSettings: cloneDefaults(),
  setScale: (scale) => {
    if (Number.isFinite(scale) && scale > 0) set({ scale });
  },
  setTileSize: (tileSize, bbox) => {
    if (!Number.isFinite(tileSize)) return;
    const size = Math.max(50, Math.min(1000, tileSize));
    if (bbox) {
      const dimensions = getBboxDimensions(bbox, 1000);
      set({
        tileSize: size,
        scale:
          (Math.max(dimensions.widthMm, dimensions.heightMm) * 1000) / size,
      });
    } else set({ tileSize: size });
  },
  fitSelection: (bbox) => get().setTileSize(get().tileSize, bbox),
  setProfile: (profile) =>
    set((s) => ({
      profile,
      modelSettings: {
        ...s.modelSettings,
        print: { ...PRINT_PROFILES[profile].print },
        features: {
          ...s.modelSettings.features,
          roads: {
            ...s.modelSettings.features.roads,
            filter: PRINT_PROFILES[profile].roads,
            footpathsEnabled: profile === "detail",
          },
        },
      },
    })),
  updatePrintSettings: (partial) =>
    set((s) => ({
      modelSettings: {
        ...s.modelSettings,
        print: { ...s.modelSettings.print, ...partial },
      },
    })),
  updateBaseSettings: (partial) =>
    set((s) => ({
      modelSettings: {
        ...s.modelSettings,
        base: { ...s.modelSettings.base, ...partial },
      },
    })),
  updateFeatureSettings: (layer, partial) =>
    set((s) => ({
      modelSettings: {
        ...s.modelSettings,
        features: {
          ...s.modelSettings.features,
          [layer]: { ...s.modelSettings.features[layer], ...partial },
        },
      },
    })),
  resetSettings: () =>
    set({ modelSettings: cloneDefaults(), profile: "balanced" }),
  saveProject: (snapshot, name = "printmap-projet") =>
    JSON.stringify(
      {
        version: 2,
        name,
        timestamp: new Date().toISOString(),
        settings: get().modelSettings,
        scale: get().scale,
        tileSize: get().tileSize,
        profile: get().profile,
        snapshot,
      } satisfies ProjectFile,
      null,
      2,
    ),
  loadProject: (json) => {
    const project = JSON.parse(json);
    if (!project || typeof project !== "object" || Array.isArray(project))
      throw new Error("Le fichier ne contient pas un projet PrintMap.");
    if (project.version !== 1 && project.version !== 2)
      throw new Error("Version de projet non prise en charge.");
    if (
      !Number.isFinite(project.scale) ||
      project.scale <= 0 ||
      !Number.isFinite(project.tileSize) ||
      project.tileSize < 50 ||
      project.tileSize > 1000
    )
      throw new Error("Échelle du projet invalide.");
    const settings = normalizeSettings(project.settings);
    const snapshot =
      project.version === 2 ? (project.snapshot as ProjectSnapshot) : null;
    if (
      project.version === 2 &&
      (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    )
      throw new Error("Données du projet manquantes.");
    if (snapshot) {
      if (snapshot.bbox !== null) validateBbox(snapshot.bbox);
      if (typeof snapshot.isDemo !== "boolean")
        throw new Error("Origine du projet invalide.");
      if (
        snapshot.selectedCity &&
        (typeof snapshot.selectedCity.name !== "string" ||
          !Number.isFinite(snapshot.selectedCity.lat) ||
          !Number.isFinite(snapshot.selectedCity.lng))
      )
        throw new Error("Lieu du projet invalide.");
      if (
        snapshot.osmData &&
        (!Array.isArray(snapshot.osmData.elements) ||
          snapshot.osmData.elements.length > 70000)
      )
        throw new Error("Données du projet invalides ou trop volumineuses.");
      if (snapshot.osmData && !snapshot.bbox)
        throw new Error("Les données ne sont associées à aucune zone.");
      if (snapshot.osmData) {
        validateImportedElements(snapshot.osmData.elements);
        validateRoofData(snapshot.osmData.elements);
      }
      if (snapshot.elevationGrid) {
        const grid = validateElevationGrid(snapshot.elevationGrid);
        const bounds = [grid.south, grid.west, grid.north, grid.east];
        if (
          !snapshot.bbox ||
          bounds.some(
            (value, index) => Math.abs(value - snapshot.bbox![index]) > 1e-8,
          )
        )
          throw new Error(
            "Le relief du projet ne correspond pas à la zone enregistrée.",
          );
        snapshot.elevationGrid = grid;
      }
      if (
        snapshot.report &&
        (!Array.isArray(snapshot.report.sources) ||
          !snapshot.report.sources.every((v) => typeof v === "string") ||
          !Array.isArray(snapshot.report.warnings) ||
          !snapshot.report.warnings.every((v) => typeof v === "string") ||
          typeof snapshot.report.fetchedAt !== "string" ||
          !Number.isFinite(Date.parse(snapshot.report.fetchedAt)) ||
          (snapshot.report.lod2Year !== undefined &&
            (!Number.isInteger(snapshot.report.lod2Year) ||
              snapshot.report.lod2Year < 1900 ||
              snapshot.report.lod2Year > 2100)))
      )
        throw new Error("Rapport du projet invalide.");
    }
    set({
      modelSettings: settings,
      scale: project.scale,
      tileSize: project.tileSize,
      profile:
        typeof project.profile === "string" &&
        Object.prototype.hasOwnProperty.call(PRINT_PROFILES, project.profile)
          ? project.profile
          : "balanced",
    });
    return snapshot;
  },
}));
