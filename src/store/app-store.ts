"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BBox, MapData } from "@/types/osm";
import type { BuiltModel } from "@/lib/model/build";
import { buildInWorker } from "@/lib/model/client";
import { validateBbox } from "@/lib/data/bbox";
import { DEFAULT_SETTINGS, type ModelSettings } from "@/lib/model/settings";

export type Status = "idle" | "fetching" | "building" | "ready" | "error";

interface AppState {
  bbox: BBox | null;
  settings: ModelSettings;
  data: MapData | null;
  model: BuiltModel | null;
  status: Status;
  progress: number;
  progressLabel: string;
  error: string | null;
  view: "map" | "3d";
  exploded: boolean;
  angle: "iso" | "top" | "under";
  /** Map centre, to place quick selections and to reopen where we left. */
  center: { lat: number; lng: number; zoom: number };
  flyTo: { lat: number; lng: number; id: number } | null;
  drawRequest: number;
  setBbox: (bbox: BBox | null) => void;
  selectSquare: (sideM: number) => void;
  patch: (settings: Partial<ModelSettings>) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  set: (
    state: Partial<
      Pick<
        AppState,
        "view" | "exploded" | "angle" | "center" | "flyTo" | "drawRequest"
      >
    >,
  ) => void;
}

let controller: AbortController | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  clearTimeout(rebuildTimer);
  controller?.abort();
  controller = null;
};
const cancelled = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => {
      async function build(signal: AbortSignal) {
        const { data, settings } = get();
        if (!data) return;
        set({
          status: "building",
          progress: 0,
          progressLabel: "Démarrage",
          error: null,
        });
        try {
          const model = await buildInWorker(
            { data, settings },
            signal,
            (progress, progressLabel) => set({ progress, progressLabel }),
          );
          set((state) => ({
            model,
            status: "ready",
            // Show the first result; later rebuilds leave the user where they are.
            view: state.model ? state.view : "3d",
          }));
        } catch (error) {
          if (cancelled(error)) return;
          set({
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Construction impossible.",
          });
        }
      }
      return {
        bbox: null,
        settings: DEFAULT_SETTINGS,
        data: null,
        model: null,
        status: "idle",
        progress: 0,
        progressLabel: "",
        error: null,
        view: "map",
        exploded: false,
        angle: "iso",
        center: { lat: 43.6109, lng: 3.8763, zoom: 14 },
        flyTo: null,
        drawRequest: 0,
        set: (state) => set(state),
        setBbox: (bbox) => {
          stop();
          if (bbox)
            try {
              validateBbox(bbox);
            } catch (error) {
              set({
                error:
                  error instanceof Error ? error.message : "Zone invalide.",
                status: "error",
              });
              return;
            }
          set({
            bbox,
            data: null,
            model: null,
            status: "idle",
            error: null,
            view: "map",
            angle: "iso",
          });
        },
        selectSquare: (sideM) => {
          const { lat, lng } = get().center;
          const dLat = sideM / 2 / 111195,
            dLng = dLat / Math.cos((lat * Math.PI) / 180);
          get().setBbox([lat - dLat, lng - dLng, lat + dLat, lng + dLng]);
        },
        patch: (settings) => {
          set((state) => ({ settings: { ...state.settings, ...settings } }));
          if (!get().data) return;
          // Rebuild from the data already collected, once the user pauses.
          stop();
          const mine = (controller = new AbortController());
          rebuildTimer = setTimeout(() => void build(mine.signal), 350);
        },
        generate: async () => {
          const { bbox } = get();
          if (!bbox) return;
          stop();
          const mine = (controller = new AbortController());
          set({
            status: "fetching",
            progress: 0,
            progressLabel: "Récupération des données de la zone",
            error: null,
          });
          try {
            const response = await fetch("/api/map-data", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bbox }),
              signal: mine.signal,
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body?.elements)
              throw new Error(
                body?.error ?? "Les données n’ont pas pu être récupérées.",
              );
            set({ data: body as MapData });
          } catch (error) {
            if (cancelled(error)) return;
            set({
              status: "error",
              error:
                error instanceof Error && error.name !== "TypeError"
                  ? error.message
                  : "Connexion impossible. Vérifiez le réseau puis réessayez.",
            });
            return;
          }
          await build(mine.signal);
        },
        cancel: () => {
          stop();
          set((state) => ({
            status: state.model ? "ready" : "idle",
            error: null,
          }));
        },
      };
    },
    {
      name: "printmap-v4",
      skipHydration: true,
      partialize: ({ bbox, settings, center }) => ({ bbox, settings, center }),
      merge: (saved, current) => {
        const stored = (saved ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...stored,
          settings: {
            ...DEFAULT_SETTINGS,
            ...stored.settings,
            colors: { ...DEFAULT_SETTINGS.colors, ...stored.settings?.colors },
          },
        };
      },
    },
  ),
);
