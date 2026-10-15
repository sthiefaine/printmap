import { create } from "zustand";
import type { MapDataResponse } from "@/types/osm";
import {
  createAssemblyProject,
  assemblyCellBbox,
  addAssemblyNeighbor,
  cellKey,
  cellLabel,
  alignAssemblyElevation,
  validateAssemblyProject,
  validateAssemblyData,
  initialAssemblyDatum,
  type AssemblyProject,
  type AssemblyCell,
} from "@/lib/assembly-project";
import {
  readAssemblyCell,
  saveAssemblyCell,
  listAssemblyCells,
} from "@/lib/assembly-cache";
import {
  normalizeSettings,
  useSceneStore,
  PRINT_PROFILES,
  type PrintProfile,
} from "./use-scene-store";
import { useMapStore } from "./use-map-store";
import { useAppStore } from "./use-app-store";

const ACTIVE = "printmap-assembly-active-v1";
const LAST = "printmap-assembly-last-v1";
let sequence = 0;
let pending: AbortController | null = null;
function stop() {
  sequence++;
  pending?.abort();
  pending = null;
  useMapStore.getState().cancel();
}
function persist(project: AssemblyProject) {
  try {
    localStorage.setItem(ACTIVE, JSON.stringify(project));
    localStorage.setItem(LAST, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}
function snapshot(
  project: AssemblyProject,
  cell: AssemblyCell,
  data?: MapDataResponse | null,
) {
  const bbox = assemblyCellBbox(project, cell);
  return {
    bbox,
    selectedCity: {
      name: `${project.name} · ${cellLabel(cell)}`,
      lat: (bbox[0] + bbox[2]) / 2,
      lng: (bbox[1] + bbox[3]) / 2,
    },
    osmData: data?.osmData ?? null,
    elevationGrid: data?.elevationGrid ?? null,
    report: data?.report ?? null,
    isDemo: false,
  };
}
function installSettings(project: AssemblyProject) {
  const profile = (Object.keys(PRINT_PROFILES) as PrintProfile[]).find(
    (key) =>
      JSON.stringify(PRINT_PROFILES[key].print) ===
      JSON.stringify(project.settings.print),
  );
  useSceneStore.setState({
    scale: project.scale,
    tileSize: project.usableMm,
    ...(profile ? { profile } : {}),
    modelSettings: structuredClone(project.settings),
  });
}
interface AssemblyState {
  project: AssemblyProject | null;
  lastProject: AssemblyProject | null;
  cached: string[];
  transient: { projectId: string; key: string; data: MapDataResponse } | null;
  busy: boolean;
  error: string | null;
  notice: string;
  planPersistent: boolean;
  restore: () => Promise<void>;
  start: (scale: number, datum?: number) => Promise<void>;
  open: (input: unknown) => Promise<void>;
  close: () => void;
  select: (cell: AssemblyCell) => Promise<void>;
  add: (direction: "north" | "south" | "east" | "west") => Promise<void>;
  load: () => Promise<void>;
  cancel: () => void;
  importCell: (input: unknown) => Promise<void>;
  cellBackup: () => Promise<string>;
}
export const useAssemblyStore = create<AssemblyState>((set, get) => ({
  project: null,
  lastProject: null,
  cached: [],
  transient: null,
  busy: false,
  error: null,
  notice: "",
  planPersistent: true,
  restore: async () => {
    try {
      const active = localStorage.getItem(ACTIVE),
        last = localStorage.getItem(LAST);
      if (last) set({ lastProject: validateAssemblyProject(JSON.parse(last)) });
      if (active && !get().project) await get().open(JSON.parse(active));
    } catch {
      set({
        error:
          "Reprise automatique indisponible. Ouvrez votre fichier de projet ou créez un plan et enregistrez-le dans un fichier.",
        planPersistent: false,
      });
    }
  },
  start: async (scale, datum) => {
    const map = useMapStore.getState();
    if (!map.bbox) return;
    try {
      const project = createAssemblyProject(
        map.bbox,
        scale,
        normalizeSettings(useSceneStore.getState().modelSettings),
        map.selectedCity?.name || "Maquette de ville",
      );
      if (datum !== undefined) project.elevationDatumM = datum;
      await get().open(project);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Création impossible.",
      });
    }
  },
  open: async (input) => {
    const project = validateAssemblyProject(input);
    project.settings = normalizeSettings(project.settings);
    stop();
    const id = sequence;
    // Persist the small plan only. Large acquired data stays per cell in IndexedDB.
    const planPersistent = persist(project);
    set({
      project,
      planPersistent,
      lastProject: project,
      cached: [],
      transient: null,
      error: null,
      notice: "Plan enregistré dans ce navigateur. Aucune collecte globale.",
      busy: false,
    });
    installSettings(project);
    const cell = project.activeCell ?? project.cells[0];
    await useMapStore.getState().openAssemblyCell(
      snapshot(project, cell),
      project.elevationDatumM == null
        ? null
        : {
            originLat: project.origin.lat,
            elevationDatumM: project.elevationDatumM,
          },
    );
    try {
      const cached = await listAssemblyCells(project.id);
      const currentProject = get().project;
      if (currentProject?.id === project.id)
        set({
          cached: [...new Set([...get().cached, ...cached])].filter((key) =>
            currentProject.cells.some((cell) => cellKey(cell) === key),
          ),
        });
    } catch {
      if (id === sequence)
        set({
          notice:
            "Le stockage local est indisponible. Les données de chaque plaque devront être enregistrées dans un fichier.",
        });
    }
  },
  close: () => {
    stop();
    const project = get().project;
    try {
      if (project) localStorage.setItem(LAST, JSON.stringify(project));
      localStorage.removeItem(ACTIVE);
    } catch {
      /* File saving remains available when browser storage is blocked. */
    }
    set({
      project: null,
      lastProject: project,
      cached: [],
      transient: null,
      busy: false,
      error: null,
    });
    useMapStore.getState().reset();
    useAppStore.getState().setViewMode("map");
  },
  select: async (cell) => {
    const current = get().project;
    if (
      !current ||
      !current.cells.some((item) => cellKey(item) === cellKey(cell))
    )
      return;
    const bbox = useMapStore.getState().bbox;
    const targetBbox = assemblyCellBbox(current, cell);
    if (
      current.activeCell &&
      cellKey(current.activeCell) === cellKey(cell) &&
      bbox?.every((value, index) => value === targetBbox[index])
    )
      return;
    stop();
    const project = { ...current, activeCell: cell };
    const planPersistent = persist(project);
    set({
      project,
      planPersistent,
      busy: false,
      transient:
        get().transient?.key === cellKey(cell) ? get().transient : null,
      error: null,
      notice: "Seule la plaque choisie sera chargée en mémoire.",
    });
    installSettings(project);
    await useMapStore.getState().openAssemblyCell(
      snapshot(project, cell),
      project.elevationDatumM == null
        ? null
        : {
            originLat: project.origin.lat,
            elevationDatumM: project.elevationDatumM,
          },
    );
  },
  add: async (direction) => {
    const current = get().project;
    if (!current) return;
    try {
      const project = addAssemblyNeighbor(
        current,
        current.activeCell ?? current.cells[0],
        direction,
      );
      const planPersistent = persist(project);
      set({ project, planPersistent, error: null });
      await get().select(
        project.activeCell ?? project.cells[project.cells.length - 1],
      );
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Extension impossible.",
      });
    }
  },
  load: async () => {
    const original = get().project;
    if (!original) return;
    stop();
    const id = sequence;
    const cell = original.activeCell ?? original.cells[0];
    const currentController = new AbortController();
    pending = currentController;
    const signal = currentController.signal;
    set({
      busy: true,
      error: null,
      notice: "Chargement de cette plaque uniquement…",
    });
    const timeout = setTimeout(
      () =>
        currentController.abort(
          new Error(
            "La collecte de cette plaque a dépassé le délai. Réessayez.",
          ),
        ),
      180000,
    );
    try {
      let cacheIssue = false;
      let data: MapDataResponse | null = null;
      const transient = get().transient;
      if (
        transient?.projectId === original.id &&
        transient.key === cellKey(cell)
      )
        data = transient.data;
      else {
        try {
          data = await readAssemblyCell(original.id, cell);
        } catch {
          cacheIssue = true;
        }
      }
      if (id !== sequence) return;
      if (!data) {
        const response = await fetch("/api/map-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bbox: assemblyCellBbox(original, cell),
            relief: original.settings.base.topographyEnabled,
          }),
          signal,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "Collecte de cette plaque impossible. Réessayez.",
          );
        data = validateAssemblyData(result, assemblyCellBbox(original, cell));
      } else
        data = validateAssemblyData(data, assemblyCellBbox(original, cell));
      if (id !== sequence || signal.aborted) return;
      let project = get().project!;
      if (project.settings.base.topographyEnabled) {
        if (!data.elevationGrid)
          throw new Error(
            "Le relief de cette plaque est indisponible. Réessayez pour conserver les raccords du projet.",
          );
        const aligned = alignAssemblyElevation(
          project,
          cell,
          data.elevationGrid,
        );
        project = {
          ...project,
          boundaryElevations: aligned.boundaryElevations,
          elevationDatumM:
            project.elevationDatumM ??
            initialAssemblyDatum(aligned.grid.minElev),
        };
        data = {
          ...data,
          elevationGrid: aligned.grid,
          report: {
            ...data.report,
            elevationResolutionM: aligned.grid.resolutionM ?? null,
            warnings: [
              ...new Set([
                ...data.report.warnings,
                ...(aligned.grid.warnings ?? []),
              ]),
            ],
          },
        };
        if (aligned.grid.minElev < project.elevationDatumM!)
          throw new Error(
            "Cette plaque descend sous le socle du projet. Son relief ne peut pas être aplati : créez un projet avec un repère plus bas.",
          );
      } else
        project = { ...project, elevationDatumM: project.elevationDatumM ?? 0 };
      let stored = false;
      try {
        await saveAssemblyCell(project.id, cell, data);
        stored = true;
      } catch {
        cacheIssue = true;
      }
      if (id !== sequence || signal.aborted) return;
      const planPersistent = persist(project);
      set({
        project,
        planPersistent,
        cached: stored
          ? [...new Set([...get().cached, cellKey(cell)])]
          : get().cached.filter((key) => key !== cellKey(cell)),
        transient: stored
          ? null
          : { projectId: project.id, key: cellKey(cell), data },
        notice:
          "Données de cette plaque conservées dans ce navigateur. Construction en cours…",
      });
      clearTimeout(timeout);
      installSettings(project);
      await useMapStore.getState().openAssemblyCell(
        snapshot(project, cell, data),
        {
          originLat: project.origin.lat,
          elevationDatumM: project.elevationDatumM!,
        },
        true,
      );
      if (id === sequence)
        set({
          notice:
            useMapStore.getState().status === "done"
              ? cacheIssue && !stored
                ? "Plaque prête. Stockage local indisponible : enregistrez les données de cette plaque avant d’en changer."
                : "Plaque prête. Vous pouvez l’exporter ou en choisir une autre."
              : !stored
                ? "Construction interrompue. Les données restent seulement en mémoire : enregistrez le fichier de cette plaque avant d’en changer."
                : "Données conservées. Vous pouvez réessayer la construction de cette plaque.",
        });
    } catch (err) {
      if (id === sequence)
        set({
          error:
            err instanceof Error
              ? err.message
              : "Chargement impossible. Réessayez cette plaque.",
          notice:
            "La préparation de cette plaque s’est interrompue. Les autres plaques sont conservées.",
        });
    } finally {
      clearTimeout(timeout);
      if (id === sequence) set({ busy: false });
    }
  },
  cancel: () => {
    stop();
    set({
      busy: false,
      notice: "Préparation annulée. Les autres plaques sont conservées.",
    });
  },
  importCell: async (input) => {
    const file = input as {
      kind?: string;
      version?: number;
      project?: unknown;
      cell?: AssemblyCell;
      data?: unknown;
    };
    if (file?.kind !== "assembly-cell" || file.version !== 1 || !file.cell)
      throw new Error("Fichier de plaque invalide.");
    const project = validateAssemblyProject(file.project);
    project.settings = normalizeSettings(project.settings);
    if (!project.cells.some((cell) => cellKey(cell) === cellKey(file.cell!)))
      throw new Error("La plaque n’appartient pas au projet.");
    const data = validateAssemblyData(
      file.data,
      assemblyCellBbox(project, file.cell),
    );
    const current = get().project;
    if (current && current.id !== project.id)
      throw new Error(
        "Cette plaque appartient à un autre projet. Ouvrez d’abord son plan.",
      );
    // Keep the most recent extent and fixed borders when restoring an older tile backup.
    const target = current ?? project;
    if (
      JSON.stringify(target.origin) !== JSON.stringify(project.origin) ||
      target.scale !== project.scale ||
      target.elevationDatumM !== project.elevationDatumM ||
      JSON.stringify(target.settings) !== JSON.stringify(project.settings)
    )
      throw new Error(
        "Les repères de cette plaque ne correspondent pas au projet.",
      );
    if (!target.cells.some((cell) => cellKey(cell) === cellKey(file.cell!)))
      throw new Error("Ajoutez d’abord cette plaque au plan du projet.");
    stop();
    const id = sequence;
    let stored = false;
    try {
      await saveAssemblyCell(target.id, file.cell, data);
      stored = true;
    } catch {
      /* The active parcel can still be reconstructed and backed up. */
    }
    if (id !== sequence) return;
    const opening = get().open({ ...target, activeCell: file.cell });
    const openedSequence = sequence;
    await opening;
    if (openedSequence !== sequence) return;
    set({
      transient: stored
        ? null
        : { projectId: target.id, key: cellKey(file.cell), data },
      notice: stored
        ? "Données de la plaque restaurées. Construisez-la sans nouvelle collecte."
        : "Données restaurées en mémoire. Le stockage local est indisponible : conservez votre fichier de plaque.",
    });
  },
  cellBackup: async () => {
    const project = get().project;
    if (!project) throw new Error("Aucun projet actif.");
    const cell = project.activeCell ?? project.cells[0];
    const transient = get().transient;
    const data =
      transient?.projectId === project.id && transient.key === cellKey(cell)
        ? transient.data
        : await readAssemblyCell(project.id, cell);
    if (!data) throw new Error("Chargez d’abord les données de cette plaque.");
    return JSON.stringify({
      kind: "assembly-cell",
      version: 1,
      project,
      cell,
      data,
    });
  },
}));
