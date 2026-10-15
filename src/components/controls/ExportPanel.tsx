"use client";
import { useState } from "react";
import { useSceneStore } from "@/store/use-scene-store";
import { useMapStore } from "@/store/use-map-store";
import { exportToSTL } from "@/lib/export/stl-export";
import { exportTo3MF } from "@/lib/export/threemf-export";
import { validateExportLayout } from "@/lib/export/validate-layout";
import {
  fitPlateCount,
  splitAtCurrentScale,
  MAX_PRINT_TILES,
  type PlateLayout,
  type PlateSizeMm,
} from "@/lib/plate-layout";
export function ExportPanel() {
  const model = useMapStore((s) => s.model);
  const status = useMapStore((s) => s.status);
  const report = useMapStore((s) => s.report);
  const grid = useSceneStore((s) => s.modelSettings.base.grid);
  const storedPlate = useSceneStore((s) => s.modelSettings.base.plateSizeMm);
  const scale = useSceneStore((s) => s.scale);
  const bbox = useMapStore((s) => s.bbox);
  const update = useSceneStore((s) => s.updateBaseSettings);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const isDemo = useMapStore((s) => s.isDemo);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const layoutKey = `${bbox?.join(",")}:${scale}:${grid.cols}:${grid.rows}:${storedPlate}`;
  const [draft, setDraft] = useState<{
    key: string;
    count: number;
    plate: PlateSizeMm;
  } | null>(null);
  const pending = draft?.key === layoutKey;
  const count = pending ? draft.count : grid.cols * grid.rows;
  const plate = pending ? draft.plate : (storedPlate ?? 150);
  const busy = status === "processing" || status === "fetching" || exporting;
  const fitted = bbox ? fitPlateCount(bbox, count, plate) : null;
  let preserved: PlateLayout | null = null;
  let preserveError = "";
  if (bbox) {
    try {
      preserved = splitAtCurrentScale(bbox, scale, plate);
    } catch (err) {
      preserveError =
        err instanceof Error ? err.message : "Découpage indisponible.";
    }
  }
  let layoutError = "";
  if (model && status === "done") {
    try {
      validateExportLayout(model, grid);
    } catch (err) {
      layoutError =
        err instanceof Error ? err.message : "Découpage à actualiser.";
    }
  }
  const applyLayout = (layout: PlateLayout) => {
    const scene = useSceneStore.getState();
    useSceneStore.setState({
      tileSize: layout.longSideMm,
      scale: layout.scale,
      modelSettings: {
        ...scene.modelSettings,
        base: {
          ...scene.modelSettings.base,
          grid: { ...layout.grid },
          plateSizeMm: layout.plateSizeMm,
        },
      },
    });
    setDraft(null);
    setError("");
  };
  const changeGrid = (next: typeof grid) => {
    if (next.cols * next.rows > MAX_PRINT_TILES) {
      setError(`Le découpage est limité à ${MAX_PRINT_TILES} plaques.`);
      return;
    }
    update({ grid: next });
    setError("");
  };
  const mm = (value: number) =>
    value.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
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
  const disabled =
    !model || status !== "done" || exporting || pending || !!layoutError;
  return (
    <div className="export-panel">
      <div className="plate-planner">
        <h3>Découper en plaques</h3>
        <div className="profiles" role="group" aria-label="Taille des plaques">
          {([150, 100] as const).map((size) => (
            <button
              key={size}
              disabled={!bbox || busy}
              aria-pressed={plate === size}
              className={plate === size ? "selected" : ""}
              onClick={() => setDraft({ key: layoutKey, count, plate: size })}
            >
              {size / 10} × {size / 10} cm
            </button>
          ))}
        </div>
        <p className="field-hint">
          5 mm de marge totale : surface utile de {plate - 5} × {plate - 5} mm
          par plaque.
        </p>
        <label className="plate-count">
          Nombre de plaques
          <input
            type="number"
            aria-label="Nombre de plaques"
            min={1}
            max={MAX_PRINT_TILES}
            step={1}
            disabled={!bbox || busy}
            value={count}
            onChange={(event) =>
              setDraft({
                key: layoutKey,
                plate,
                count: Math.max(
                  1,
                  Math.min(
                    MAX_PRINT_TILES,
                    Math.round(Number(event.target.value) || 1),
                  ),
                ),
              })
            }
          />
        </label>
        {fitted ? (
          <>
            <p className="field-hint">
              Après « Adapter » : {mm(fitted.widthMm)} × {mm(fitted.depthMm)} mm
              assemblés. {fitted.grid.cols} colonnes × {fitted.grid.rows} lignes
              ; chaque pièce {mm(fitted.tileWidthMm)} × {mm(fitted.tileDepthMm)}{" "}
              mm.
            </p>
            <svg
              className="plate-preview"
              role="img"
              aria-label={`Plan proposé : ${count} plaques, nord en haut`}
              viewBox={`0 0 ${fitted.widthMm} ${fitted.depthMm}`}
            >
              {Array.from({ length: count }, (_, index) => {
                const col = index % fitted.grid.cols,
                  row = Math.floor(index / fitted.grid.cols);
                const x = col * fitted.tileWidthMm,
                  y = (fitted.grid.rows - 1 - row) * fitted.tileDepthMm;
                return (
                  <g key={index}>
                    <rect
                      x={x}
                      y={y}
                      width={fitted.tileWidthMm}
                      height={fitted.tileDepthMm}
                    />
                    <text
                      x={x + fitted.tileWidthMm / 2}
                      y={y + fitted.tileDepthMm / 2}
                      dominantBaseline="middle"
                      textAnchor="middle"
                      fontSize={Math.min(
                        fitted.tileWidthMm / 5,
                        fitted.tileDepthMm / 4,
                        12,
                      )}
                    >
                      {row + 1}–{col + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p className="field-hint">
              Plan d’assemblage · nord en haut. L’échelle proposée est 1:
              {Math.round(fitted.scale).toLocaleString("fr-FR")}.
            </p>
          </>
        ) : null}
        <button
          className="button button-secondary button-full"
          disabled={!fitted || busy}
          onClick={() => fitted && applyLayout(fitted)}
        >
          Adapter sur {count} plaque{count > 1 ? "s" : ""}
        </button>
        <p className="field-hint">
          Adapte la taille de la maquette à ces plaques. L’agrandir conserve
          davantage de petits volumes. La zone et les données restent les mêmes.
        </p>
        <button
          className="button button-quiet button-full"
          disabled={!preserved || busy}
          onClick={() => preserved && applyLayout(preserved)}
        >
          Découper sans changer la taille
          {preserved
            ? ` · ${preserved.count} plaque${preserved.count > 1 ? "s" : ""}`
            : ""}
        </button>
        <p className="field-hint">
          Conserve l’échelle et le niveau de détail actuels, puis calcule le
          nombre de plaques nécessaire.
        </p>
        {preserveError ? (
          <p className="field-hint warning">{preserveError}</p>
        ) : null}
        {pending ? (
          <p className="field-hint" role="status">
            Appliquez l’un des découpages avant de télécharger.
          </p>
        ) : null}
      </div>
      <p className="field-hint">
        Découpage actuel · colonnes et lignes modifiables.
      </p>
      <div className="tile-fields">
        <label>
          Colonnes
          <input
            type="number"
            aria-label="Colonnes de tuiles"
            min={1}
            max={MAX_PRINT_TILES}
            step={1}
            value={grid.cols}
            onChange={(e) =>
              changeGrid({
                ...grid,
                cols: Math.max(
                  1,
                  Math.min(
                    MAX_PRINT_TILES,
                    Math.round(Number(e.target.value) || 1),
                  ),
                ),
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
            max={MAX_PRINT_TILES}
            step={1}
            value={grid.rows}
            onChange={(e) =>
              changeGrid({
                ...grid,
                rows: Math.max(
                  1,
                  Math.min(
                    MAX_PRINT_TILES,
                    Math.round(Number(e.target.value) || 1),
                  ),
                ),
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
      {layoutError ? (
        <p className="field-hint warning" role="alert">
          {layoutError}
        </p>
      ) : null}
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
        3MF : couleurs par surface. STL : une matière. À 0 mm, routes et jardins
        se distinguent par leur couleur ; pour les lire en STL, choisissez une
        légère gravure. Les exports sont en millimètres, posés à plat sur le
        plateau.
      </p>
      {model &&
      (model.stats.basinRimCount > 0 ||
        model.stats.reconstructedAqueductCount > 0) ? (
        <p className="field-hint">
          {model.stats.basinRimCount > 0
            ? `${model.stats.basinRimCount} bordure${model.stats.basinRimCount > 1 ? "s" : ""} de bassin reconstituée${model.stats.basinRimCount > 1 ? "s" : ""}. `
            : ""}
          {model.stats.reconstructedAqueductCount > 0
            ? `${model.stats.reconstructedAqueductCount} aqueduc${model.stats.reconstructedAqueductCount > 1 ? "s" : ""} reconstitué${model.stats.reconstructedAqueductCount > 1 ? "s" : ""}, ${model.stats.aqueductArchCount} arches au profil documentaire approché. `
            : ""}
          Consultez les hypothèses dans le rapport. Les voûtes peuvent demander
          des supports dans le slicer.
        </p>
      ) : null}
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
