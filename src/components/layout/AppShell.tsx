"use client";
import { useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAppStore } from "@/store/use-app-store";
import { useMapStore } from "@/store/use-map-store";
import { useSceneStore } from "@/store/use-scene-store";
import { ViewToggle } from "./ViewToggle";
import { SidePanel } from "./SidePanel";
import { ProjectManager } from "@/components/controls/ProjectManager";
import { LoadingOverlay } from "@/components/ui/LoadingOverlay";
import { Scene3DWrapper } from "@/components/viewer/Scene3DWrapper";
import { QualityReport } from "./QualityReport";
const MapView = dynamic(
  () => import("@/components/map/MapView").then((m) => m.MapView),
  {
    ssr: false,
    loading: () => <div className="map-loading">Chargement de la carte…</div>,
  },
);
export function AppShell() {
  const viewMode = useAppStore((s) => s.viewMode);
  const settings = useSceneStore((s) => s.modelSettings);
  const scale = useSceneStore((s) => s.scale);
  const status = useMapStore((s) => s.status);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const isDemo = useMapStore((s) => s.isDemo);
  const mobileSettings = useAppStore((s) => s.settingsPanelOpen);
  const setMobileSettings = useAppStore((s) => s.setSettingsPanelOpen);
  useEffect(() => {
    const store = useMapStore.getState();
    const key = JSON.stringify({ scale, settings });
    if (!store.osmData || store.status === "fetching" || store.buildKey === key)
      return;
    store.invalidateModel();
    const timer = setTimeout(() => void useMapStore.getState().rebuild(), 350);
    return () => clearTimeout(timer);
  }, [settings, scale]);
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/" aria-label="PrintMap, accueil">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <path
              d="M5 22 18 29 31 22M5 16 18 23 31 16M5 10 18 17 31 10 18 3Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          <span>
            print<span>map</span>
          </span>
          <em>ATELIER 3D</em>
        </Link>
        <p>Vos lieux, en volume.</p>
        <ProjectManager />
        <button
          className="mobile-settings button button-secondary"
          aria-expanded={mobileSettings}
          onClick={() => setMobileSettings(!mobileSettings)}
        >
          {mobileSettings ? "Voir l'atelier" : "Réglages"}
        </button>
      </header>
      <div className={`workspace ${mobileSettings ? "settings-open" : ""}`}>
        <SidePanel />
        <main className="main-stage">
          <div className="stage-header">
            <div>
              <span className="stage-eyebrow">
                {isDemo ? "QUARTIER SYNTHÉTIQUE" : "CARTE → OBJET"}
              </span>
              <h1>{selectedCity?.name || "Un morceau du monde"}</h1>
            </div>
            <ViewToggle />
          </div>
          <div className="stage-viewport">
            <div
              className={`map-container ${viewMode === "map" ? "" : "is-hidden"}`}
              aria-hidden={viewMode !== "map"}
              inert={viewMode !== "map"}
            >
              <MapView />
            </div>
            {viewMode === "preview" ? <Scene3DWrapper /> : null}
            <LoadingOverlay />
            {viewMode === "preview" && status === "done" ? (
              <QualityReport />
            ) : null}
            {isDemo && viewMode === "preview" ? (
              <div className="demo-badge">
                Données synthétiques · essai hors ligne
              </div>
            ) : null}
          </div>
          <footer className="stage-footer">
            <span>
              <i
                className={`footer-status ${status === "done" ? "ready" : ""}`}
              />
              {status === "done"
                ? "Prêt à exporter"
                : status === "processing"
                  ? "Volumes en construction"
                  : status === "fetching"
                    ? "Données en cours de collecte"
                    : "Délimitez votre zone et préparez votre pièce"}
            </span>
            <span>OpenStreetMap · IGN en France · dimensions en mm</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
