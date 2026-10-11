"use client";
import { useState } from "react";
import { useSceneStore } from "@/store/use-scene-store";
import { useMapStore } from "@/store/use-map-store";
import { exportToSTL } from "@/lib/export/stl-export";
import { exportTo3MF } from "@/lib/export/threemf-export";
export function ExportPanel() {
  const model = useMapStore((s) => s.model);
  const status = useMapStore((s) => s.status);
  const report = useMapStore((s) => s.report);
  const grid = useSceneStore((s) => s.modelSettings.base.grid);
  const update = useSceneStore((s) => s.updateBaseSettings);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const isDemo = useMapStore((s) => s.isDemo);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const handleExport = async (format: "stl" | "3mf") => {
    if (!model || status !== "done") return;
    setExporting(true);
    setError("");
    const stem = isDemo
      ? "printmap-demo-synthetique"
      : `printmap-${(selectedCity?.name.split(",")[0] || "zone").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    try {
      if (format === "stl") await exportToSTL(model, `${stem}.stl`, grid);
      else await exportTo3MF(model, `${stem}.3mf`, grid);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Export impossible. Réessayez.",
      );
    } finally {
      setExporting(false);
    }
  };
  const disabled = !model || status !== "done" || exporting;
  return (
    <div className="export-panel">
      <div className="tile-fields">
        <label>
          Colonnes
          <input
            type="number"
            aria-label="Colonnes de tuiles"
            min={1}
            max={5}
            step={1}
            value={grid.cols}
            onChange={(e) =>
              update({
                grid: {
                  ...grid,
                  cols: Math.max(
                    1,
                    Math.min(5, Math.round(Number(e.target.value) || 1)),
                  ),
                },
              })
            }
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          Lignes
          <input
            type="number"
            aria-label="Lignes de tuiles"
            min={1}
            max={5}
            step={1}
            value={grid.rows}
            onChange={(e) =>
              update({
                grid: {
                  ...grid,
                  rows: Math.max(
                    1,
                    Math.min(5, Math.round(Number(e.target.value) || 1)),
                  ),
                },
              })
            }
          />
        </label>
      </div>
      {model ? (
        <p className="field-hint">
          {(model.dimensions.widthMm / grid.cols).toFixed(0)} ×{" "}
          {(model.dimensions.depthMm / grid.rows).toFixed(0)} mm par pièce.
          {grid.cols * grid.rows > 1
            ? ` ${grid.cols * grid.rows} tuiles fermées dans un ZIP.`
            : " Une pièce."}
        </p>
      ) : (
        <p className="field-hint">
          Le fichier devient disponible après la construction 3D.
        </p>
      )}
      <button
        disabled={disabled}
        className="button button-primary button-full"
        onClick={() => void handleExport("3mf")}
      >
        {exporting ? "Export en cours…" : "Télécharger le 3MF"}
        <span aria-hidden="true">↓</span>
      </button>
      <button
        disabled={disabled}
        className="button button-secondary button-full"
        onClick={() => void handleExport("stl")}
      >
        Télécharger le STL<span aria-hidden="true">↓</span>
      </button>
      <p className="field-hint">
        3MF : couleurs par surface. STL : une matière. Les exports sont en
        millimètres, posés à plat sur le plateau.
      </p>
      {report && !isDemo ? (
        <p className="field-hint export-attribution">
          Données ©{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            OpenStreetMap
          </a>{" "}
          ·{" "}
          {report.sources.some((source) => source.includes("IGN")) ? (
            <a
              href="https://geoservices.ign.fr/"
              target="_blank"
              rel="noreferrer"
            >
              IGN
            </a>
          ) : null}{" "}
          Sources et date de collecte incluses dans les fichiers 3MF et les
          archives de tuiles.
        </p>
      ) : null}
      {error ? (
        <p className="field-hint warning" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
