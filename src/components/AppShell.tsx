"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useAppStore } from "@/store/app-store";
import { MapView } from "./MapView";
import { Panel } from "./Panel";

const Viewer3D = dynamic(() => import("./Viewer3D"), { ssr: false });

export function AppShell() {
  const view = useAppStore((s) => s.view);
  const model = useAppStore((s) => s.model);
  const status = useAppStore((s) => s.status);
  const progress = useAppStore((s) => s.progress);
  const progressLabel = useAppStore((s) => s.progressLabel);
  const exploded = useAppStore((s) => s.exploded);
  const angle = useAppStore((s) => s.angle);
  const set = useAppStore((s) => s.set);
  const [hydrated, setHydrated] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  useEffect(() => {
    void Promise.resolve(useAppStore.persist.rehydrate()).then(() =>
      setHydrated(true),
    );
  }, []);
  const busy = status === "fetching" || status === "building";
  const multi = !!model && model.tiles.length > 1;
  const tab = (active: boolean) =>
    `rounded-md px-3.5 py-1.5 text-[13px] font-medium ${active ? "bg-green text-white" : "text-ink hover:bg-panel"}`;
  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs ${active ? "bg-white text-ink" : "text-white/80 hover:bg-white/10"}`;

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside
        className={`z-10 flex w-full shrink-0 flex-col border-line bg-panel md:h-full md:w-[380px] md:border-r ${panelOpen ? "h-[58dvh]" : "h-auto"} order-2 border-t md:order-1 md:border-t-0`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h1 className="text-lg font-semibold tracking-tight">
            print<span className="text-accent">map</span>
            <span className="ml-2 text-xs font-normal text-muted">
              votre ville à imprimer
            </span>
          </h1>
          <button
            className="rounded-md border border-line bg-white px-2 py-1 text-xs md:hidden"
            onClick={() => setPanelOpen(!panelOpen)}
          >
            {panelOpen ? "Réduire" : "Réglages"}
          </button>
        </header>
        <div className={`min-h-0 flex-1 ${panelOpen ? "" : "hidden md:block"}`}>
          {hydrated ? <Panel /> : null}
        </div>
      </aside>

      <main className="relative order-1 min-h-0 flex-1 md:order-2">
        <div className={view === "map" ? "absolute inset-0" : "hidden"}>
          {hydrated ? <MapView /> : null}
        </div>
        {view === "3d" && model ? (
          <div className="absolute inset-0">
            <Viewer3D model={model} angle={angle} />
            <div className="absolute bottom-4 left-4 right-4 flex w-fit flex-wrap gap-1 rounded-lg bg-black/45 p-1 backdrop-blur">
              {(
                [
                  ["iso", "Perspective"],
                  ["top", "Dessus"],
                  ["under", "Dessous"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  className={chip(angle === value)}
                  aria-pressed={angle === value}
                  onClick={() => set({ angle: value })}
                >
                  {text}
                </button>
              ))}
              {multi ? (
                <button
                  className={chip(exploded)}
                  aria-pressed={exploded}
                  onClick={() => set({ exploded: !exploded })}
                >
                  Écarter les plaques
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          className="absolute left-4 top-4 flex gap-1 rounded-lg bg-white p-1 shadow-md"
          role="group"
          aria-label="Vue"
        >
          <button
            className={tab(view === "map")}
            aria-pressed={view === "map"}
            onClick={() => set({ view: "map" })}
          >
            Carte
          </button>
          <button
            className={tab(view === "3d")}
            aria-pressed={view === "3d"}
            disabled={!model}
            onClick={() => set({ view: "3d" })}
          >
            Aperçu 3D
          </button>
        </div>

        {busy ? (
          <div
            className="absolute left-1/2 top-4 w-72 -translate-x-1/2 rounded-xl bg-white px-4 py-3 shadow-lg"
            role="status"
          >
            <div className="flex items-center gap-2.5 text-[13px]">
              <span
                className="h-4 w-4 shrink-0 rounded-full border-2 border-line border-t-green"
                style={{ animation: "spin 0.8s linear infinite" }}
              />
              <span className="flex-1">
                {status === "fetching"
                  ? "Récupération des données…"
                  : progressLabel}
              </span>
              <button
                className="text-xs text-muted underline"
                onClick={() => useAppStore.getState().cancel()}
              >
                Annuler
              </button>
            </div>
            {status === "building" ? (
              <div className="mt-2 h-1 overflow-hidden rounded bg-line">
                <div
                  className="h-full bg-green transition-[width]"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}
