"use client";
import { useMapStore } from "@/store/use-map-store";
import { useSceneStore } from "@/store/use-scene-store";
export function GenerateButton() {
  const bbox = useMapStore((s) => s.bbox);
  const status = useMapStore((s) => s.status);
  const isDemo = useMapStore((s) => s.isDemo);
  const hasData = useMapStore((s) => !!s.osmData);
  const generate = useMapStore((s) => s.generate);
  const rebuild = useMapStore((s) => s.rebuild);
  const refreshRelief = useMapStore((s) => s.refreshRelief);
  const hasRelief = useMapStore((s) => !!s.elevationGrid);
  const reliefEnabled = useSceneStore(
    (s) => s.modelSettings.base.topographyEnabled,
  );
  const busy = status === "fetching" || status === "processing";
  const resume = hasData && status !== "done";
  const label = busy
    ? "Préparation en cours…"
    : resume
      ? reliefEnabled && !hasRelief
        ? "Récupérer le relief et construire"
        : "Construire avec les données reçues"
      : status === "done"
        ? isDemo
          ? "Collecter les données réelles"
          : "Actualiser les données"
        : "Récupérer et construire";
  return (
    <button
      className="button button-primary button-full"
      disabled={!bbox || busy}
      onClick={() =>
        void (resume
          ? reliefEnabled && !hasRelief
            ? refreshRelief()
            : rebuild()
          : generate())
      }
    >
      <span aria-hidden="true">↗</span>
      {label}
    </button>
  );
}
