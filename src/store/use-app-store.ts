import { create } from "zustand";
export type SelectionTool = "rectangle";
interface AppState {
  viewMode: "map" | "preview";
  selectionTool: SelectionTool;
  drawingRevision: number;
  settingsPanelOpen: boolean;
  setViewMode: (mode: "map" | "preview") => void;
  setSelectionTool: (tool: SelectionTool) => void;
  setSettingsPanelOpen: (open: boolean) => void;
}
export const useAppStore = create<AppState>((set) => ({
  viewMode: "map",
  selectionTool: "rectangle",
  drawingRevision: 0,
  settingsPanelOpen: false,
  setViewMode: (viewMode) =>
    set((s) => ({
      viewMode,
      settingsPanelOpen: viewMode === "preview" ? false : s.settingsPanelOpen,
    })),
  setSettingsPanelOpen: (settingsPanelOpen) => set({ settingsPanelOpen }),
  setSelectionTool: (selectionTool) =>
    set((s) => ({
      selectionTool,
      drawingRevision: s.drawingRevision + 1,
      viewMode: "map",
    })),
}));
