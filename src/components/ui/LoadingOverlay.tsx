"use client";
import { useMapStore } from "@/store/use-map-store";
import { useSceneStore } from "@/store/use-scene-store";
import { useAssemblyStore } from "@/store/use-assembly-store";
export function LoadingOverlay() {
  const status = useMapStore((s) => s.status);
  const error = useMapStore((s) => s.error);
  const progress = useMapStore((s) => s.progress);
  const label = useMapStore((s) => s.progressLabel);
  const cancelModel = useMapStore((s) => s.cancel);
  const assemblyBusy = useAssemblyStore((s) => s.busy);
  const cancelAssembly = useAssemblyStore((s) => s.cancel);
  const cancel = assemblyBusy ? cancelAssembly : cancelModel;
  const generate = useMapStore((s) => s.generate);
  const rebuild = useMapStore((s) => s.rebuild);
  const hasData = useMapStore((s) => !!s.osmData);
  const hasRelief = useMapStore((s) => !!s.elevationGrid);
  const refreshRelief = useMapStore((s) => s.refreshRelief);
  const reliefEnabled = useSceneStore(
    (s) => s.modelSettings.base.topographyEnabled,
  );
  if (status !== "fetching" && status !== "processing" && status !== "error")
    return null;
  return (
    <div
      className="job-panel"
      role={status === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {status === "error" ? (
        <>
          <span className="job-eyebrow">La préparation s’est interrompue</span>
          <p>{error}</p>
          <div className="job-actions">
            <button
              className="button button-primary"
              onClick={() =>
                void (hasData
                  ? reliefEnabled && !hasRelief
                    ? refreshRelief()
                    : rebuild()
                  : generate())
              }
            >
              Réessayer
            </button>
            <button className="button button-secondary" onClick={cancel}>
              Fermer
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="job-title">
            <span className="spinner" />
            <span>
              {status === "fetching"
                ? "Récupération des données"
                : "Construction du modèle"}
            </span>
          </div>
          <p>{label}</p>
          <progress
            max={100}
            value={progress}
            aria-label="Progression de la préparation"
          />
          <button className="button button-quiet" onClick={cancel}>
            Annuler
          </button>
        </>
      )}
    </div>
  );
}
