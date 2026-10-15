import { create } from "zustand";
import type {
  OverpassResponse,
  BBox,
  ElevationGrid,
  DataReport,
  MapDataResponse,
} from "@/types/osm";
import type { PrintInput, PrintModel } from "@/types/print";
import { generatePrintModel } from "@/lib/mesh/build-client";
import { validateBbox } from "@/lib/data/bbox";
import { validateElevationGrid } from "@/lib/elevation/validate-grid";
import { createDemoData, DEMO_BBOX } from "@/lib/demo";
import { useSceneStore, type ProjectSnapshot } from "./use-scene-store";
import { useAppStore } from "./use-app-store";

interface SelectedCity {
  name: string;
  lat: number;
  lng: number;
}
export type GenerationStatus =
  | "idle"
  | "fetching"
  | "processing"
  | "done"
  | "error";
let operation = 0;
let controller: AbortController | null = null;

function stopOperation() {
  operation++;
  controller?.abort();
  controller = null;
}
interface MapState {
  selectedCity: SelectedCity | null;
  bbox: BBox | null;
  osmData: OverpassResponse | null;
  elevationGrid: ElevationGrid | null;
  report: DataReport | null;
  model: PrintModel | null;
  buildKey: string | null;
  status: GenerationStatus;
  error: string | null;
  progress: number;
  progressLabel: string;
  isDemo: boolean;
  assemblyFrame: PrintInput["assemblyFrame"] | null;
  openAssemblyCell: (
    snapshot: ProjectSnapshot,
    frame: PrintInput["assemblyFrame"] | null,
    build?: boolean,
  ) => Promise<void>;
  setSelectedCity: (city: SelectedCity | null) => void;
  setBbox: (bbox: BBox | null) => void;
  setOsmData: (data: OverpassResponse | null) => void;
  setStatus: (status: GenerationStatus) => void;
  setError: (error: string | null) => void;
  generate: () => Promise<void>;
  refreshRelief: () => Promise<void>;
  rebuild: () => Promise<void>;
  invalidateModel: () => void;
  cancel: () => void;
  loadDemo: () => Promise<void>;
  importProject: (snapshot: ProjectSnapshot) => Promise<void>;
  reset: () => void;
}
export const useMapStore = create<MapState>((set, get) => ({
  selectedCity: null,
  bbox: null,
  osmData: null,
  elevationGrid: null,
  report: null,
  model: null,
  buildKey: null,
  status: "idle",
  error: null,
  progress: 0,
  progressLabel: "",
  isDemo: false,
  assemblyFrame: null,
  openAssemblyCell: async (snapshot, assemblyFrame, build = false) => {
    stopOperation();
    set({
      ...snapshot,
      assemblyFrame,
      model: null,
      buildKey: null,
      status: "idle",
      error: null,
      progress: 0,
    });
    useAppStore.getState().setViewMode("map");
    if (build && snapshot.osmData && assemblyFrame) {
      useAppStore.getState().setViewMode("preview");
      await get().rebuild();
    }
  },
  setSelectedCity: (selectedCity) => {
    stopOperation();
    set({
      selectedCity,
      assemblyFrame: null,
      bbox: null,
      osmData: null,
      elevationGrid: null,
      report: null,
      model: null,
      status: "idle",
      error: null,
      isDemo: false,
    });
    useAppStore.getState().setViewMode("map");
  },
  setBbox: (bbox) => {
    stopOperation();
    set({ assemblyFrame: null });
    if (bbox) {
      try {
        validateBbox(bbox);
      } catch (err) {
        set({
          bbox: null,
          status: "error",
          error: err instanceof Error ? err.message : "Zone invalide.",
          model: null,
          osmData: null,
          elevationGrid: null,
          report: null,
          isDemo: false,
        });
        return;
      }
      useSceneStore.getState().fitSelection(bbox);
    }
    set({
      bbox,
      status: "idle",
      osmData: null,
      elevationGrid: null,
      report: null,
      model: null,
      error: null,
      isDemo: false,
    });
  },
  setOsmData: (osmData) => set({ osmData }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: error ? "error" : "idle" }),
  generate: async () => {
    const { bbox } = get();
    if (!bbox) return;
    stopOperation();
    const id = operation;
    controller = new AbortController();
    const currentController = controller;
    const signal = currentController.signal;
    const timeout = setTimeout(
      () =>
        currentController.abort(
          new Error(
            "La collecte a dépassé le délai. Essayez une zone plus petite.",
          ),
        ),
      180000,
    );
    set({
      status: "fetching",
      error: null,
      progress: 6,
      progressLabel: "Collecte OpenStreetMap et enrichissement des bâtiments…",
      model: null,
      osmData: null,
      elevationGrid: null,
      report: null,
      isDemo: false,
    });
    try {
      const response = await fetch("/api/map-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          relief: useSceneStore.getState().modelSettings.base.topographyEnabled,
        }),
        signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error ||
            `Collecte impossible (${response.status}). Réessayez ou réduisez la zone.`,
        );
      if (id !== operation || signal.aborted) return;
      const result = data as MapDataResponse;
      if (!Array.isArray(result.osmData?.elements))
        throw new Error("La source a renvoyé des données incomplètes.");
      set({
        osmData: result.osmData,
        elevationGrid: result.elevationGrid,
        report: result.report,
        progress: 28,
      });
      clearTimeout(timeout);
      useAppStore.getState().setViewMode("preview");
      await get().rebuild();
    } catch (err) {
      if (id !== operation) return;
      set({
        error:
          err instanceof Error
            ? err.message
            : "Impossible de récupérer cette zone.",
        status: "error",
      });
    } finally {
      clearTimeout(timeout);
    }
  },
  refreshRelief: async () => {
    const { bbox, osmData } = get();
    if (!bbox || !osmData) return;
    stopOperation();
    const id = operation;
    const currentController = new AbortController();
    controller = currentController;
    const signal = currentController.signal;
    const timeout = setTimeout(
      () =>
        currentController.abort(
          new Error(
            "Le relief a dépassé le délai. Réessayez ou réduisez la zone.",
          ),
        ),
      180000,
    );
    // Set this synchronously before the settings effect can schedule a mesh
    // without the newly requested terrain. The existing geography stays local.
    set({
      status: "fetching",
      error: null,
      progress: 8,
      progressLabel: "Récupération du relief de la zone existante…",
      model: null,
      buildKey: null,
    });
    try {
      const response = await fetch("/api/elevation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox }),
        signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Le relief de cette zone n’est pas disponible. Réessayez.",
        );
      if (id !== operation || signal.aborted) return;
      const elevationGrid = validateElevationGrid(data.elevationGrid);
      const bounds = [
        elevationGrid.south,
        elevationGrid.west,
        elevationGrid.north,
        elevationGrid.east,
      ];
      if (
        bounds.some(
          (coordinate, index) => Math.abs(coordinate - bbox[index]) > 1e-8,
        )
      )
        throw new Error(
          "Le relief reçu ne correspond pas à la zone sélectionnée.",
        );
      const report = get().report;
      const source =
        typeof elevationGrid.source === "string" ? elevationGrid.source : null;
      const warnings = Array.isArray(elevationGrid.warnings)
        ? elevationGrid.warnings.filter(
            (warning) => typeof warning === "string",
          )
        : [];
      set({
        elevationGrid,
        report: report
          ? {
              ...report,
              sources: [
                ...new Set([...report.sources, ...(source ? [source] : [])]),
              ],
              warnings: [
                ...new Set([
                  ...report.warnings.filter(
                    (warning) => !/^Relief indisponible/.test(warning),
                  ),
                  ...warnings,
                ]),
              ],
              elevationSource: source,
              elevationResolutionM: elevationGrid.resolutionM ?? null,
            }
          : null,
        progress: 28,
      });
      clearTimeout(timeout);
      useAppStore.getState().setViewMode("preview");
      await get().rebuild();
    } catch (err) {
      if (id !== operation) return;
      set({
        error:
          err instanceof Error
            ? err.message
            : "Impossible de récupérer le relief.",
        status: "error",
      });
    } finally {
      clearTimeout(timeout);
    }
  },
  rebuild: async () => {
    const { bbox, osmData, elevationGrid, report, assemblyFrame } = get();
    if (!bbox || !osmData) return;
    stopOperation();
    const id = operation;
    controller = new AbortController();
    const { scale, modelSettings: settings } = useSceneStore.getState();
    set({
      buildKey: JSON.stringify({ scale, settings }),
      status: "processing",
      error: null,
      model: null,
      progress: 30,
      progressLabel: "Préparation des volumes imprimables…",
    });
    try {
      const model = await generatePrintModel(
        {
          osmData,
          bbox,
          scale,
          elevationGrid,
          settings,
          report,
          ...(assemblyFrame ? { assemblyFrame } : {}),
        },
        {
          signal: controller.signal,
          onProgress: (progress, label) => {
            if (id === operation)
              set({ progress: 30 + progress * 0.7, progressLabel: label });
          },
        },
      );
      if (id === operation)
        set({
          model,
          status: "done",
          progress: 100,
          progressLabel: "Modèle prêt",
        });
    } catch (err) {
      if (id !== operation) return;
      set({
        status: "error",
        error:
          err instanceof Error ? err.message : "La construction 3D a échoué.",
      });
    }
  },
  invalidateModel: () => {
    stopOperation();
    set({
      buildKey: null,
      model: null,
      status: "processing",
      progress: 30,
      progressLabel: "Application des réglages…",
    });
  },
  cancel: () => {
    stopOperation();
    set({
      status: "idle",
      error: null,
      progress: 0,
      progressLabel: "Opération annulée",
    });
  },
  loadDemo: async () => {
    stopOperation();
    const data = createDemoData();
    useSceneStore.getState().fitSelection(DEMO_BBOX);
    set({
      ...data,
      assemblyFrame: null,
      bbox: [...DEMO_BBOX],
      selectedCity: {
        name: "Quartier de démonstration",
        lat: 43.609,
        lng: 3.8725,
      },
      model: null,
      isDemo: true,
      error: null,
    });
    useAppStore.getState().setViewMode("preview");
    await get().rebuild();
  },
  importProject: async (snapshot) => {
    stopOperation();
    set({
      ...snapshot,
      assemblyFrame: null,
      model: null,
      status: "idle",
      error: null,
      progress: 0,
    });
    useAppStore.getState().setViewMode(snapshot.osmData ? "preview" : "map");
    if (snapshot.osmData && snapshot.bbox) await get().rebuild();
  },
  reset: () => {
    stopOperation();
    set({
      bbox: null,
      assemblyFrame: null,
      osmData: null,
      elevationGrid: null,
      report: null,
      model: null,
      status: "idle",
      error: null,
      isDemo: false,
    });
  },
}));
