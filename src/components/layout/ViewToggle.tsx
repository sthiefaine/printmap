"use client";
import { useAppStore } from "@/store/use-app-store";
import { useMapStore } from "@/store/use-map-store";
export function ViewToggle() {
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const hasData = useMapStore((s) => !!s.osmData);
  return (
    <div className="view-toggle" aria-label="Vue de l'atelier">
      <button
        aria-pressed={viewMode === "map"}
        className={viewMode === "map" ? "active" : ""}
        onClick={() => setViewMode("map")}
      >
        Carte
      </button>
      <button
        disabled={!hasData}
        aria-pressed={viewMode === "preview"}
        className={viewMode === "preview" ? "active" : ""}
        onClick={() => setViewMode("preview")}
      >
        Aperçu 3D
      </button>
    </div>
  );
}
