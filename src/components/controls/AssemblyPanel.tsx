"use client";
import { useState } from "react";
import { useAssemblyStore } from "@/store/use-assembly-store";
import { useSceneStore, type PrintProfile } from "@/store/use-scene-store";
import { useMapStore } from "@/store/use-map-store";
import { useAppStore } from "@/store/use-app-store";
import {
  createAssemblyProject,
  cellKey,
  cellLabel,
} from "@/lib/assembly-project";
import { downloadBlob } from "@/lib/export/download";
import { exportToSTL } from "@/lib/export/stl-export";
import { create3MFBuffer } from "@/lib/export/threemf-export";
import { validateExportLayout } from "@/lib/export/validate-layout";

export function AssemblyStart() {
  const bbox = useMapStore((s) => s.bbox);
  const settings = useSceneStore((s) => s.modelSettings);
  const last = useAssemblyStore((s) => s.lastProject);
  const error = useAssemblyStore((s) => s.error);
  const [scale, setScale] = useState(5000);
  const [profile, setProfile] = useState<PrintProfile>("detail");
  const [manualDatum, setManualDatum] = useState(false);
  const [datum, setDatum] = useState(0);
  let count = 0,
    widthCm = 0,
    depthCm = 0,
    issue = "";
  if (bbox) {
    try {
      const proposed = createAssemblyProject(bbox, scale, settings, "Projet");
      count = proposed.cells.length;
      widthCm =
        (Math.max(...proposed.cells.map((cell) => cell.col)) + 1) * 14.5;
      depthCm =
        (Math.max(...proposed.cells.map((cell) => cell.row)) + 1) * 14.5;
    } catch (err) {
      issue = err instanceof Error ? err.message : "Cadrage invalide.";
    }
  }
  return (
    <div className="assembly-start">
      <h3>Construire une grande maquette, plaque par plaque</h3>
      <p className="field-hint">
        Un plan extensible, puis une seule plaque à charger et à imprimer à la
        fois. Ajoutez les voisines plus tard.
      </p>
      <label className="select-field">
        Échelle du projet · 1 pour
        <input
          aria-label="Échelle du projet"
          type="number"
          min={200}
          max={34000}
          step={500}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        />
      </label>
      <details className="advanced-settings">
        <summary>Socle commun et futurs agrandissements</summary>
        <label className="select-field">
          Référence du socle
          <select
            value={manualDatum ? "manual" : "auto"}
            onChange={(e) => setManualDatum(e.target.value === "manual")}
          >
            <option value="auto">Automatique sous la première plaque</option>
            <option value="manual">Choisir une altitude commune</option>
          </select>
        </label>
        {manualDatum ? (
          <label className="select-field">
            Altitude de référence (m)
            <input
              aria-label="Altitude de référence du projet"
              type="number"
              min={-11000}
              max={8900}
              value={datum}
              onChange={(e) => setDatum(Number(e.target.value))}
            />
          </label>
        ) : null}
        <p className="field-hint">
          Près de Montpellier, 0 m permet de prolonger jusqu’à la mer. Ailleurs,
          le mode automatique réserve 50 à 100 m sous le premier terrain. Pour
          descendre davantage plus tard, choisissez une référence plus basse dès
          le départ.
        </p>
      </details>
      <label className="select-field">
        Détail du projet
        <select
          aria-label="Détail du projet"
          value={profile}
          onChange={(e) => setProfile(e.target.value as PrintProfile)}
        >
          <option value="detail">Détaillé</option>
          <option value="balanced">Équilibré</option>
          <option value="clean">Épuré</option>
        </select>
      </label>
      <p className="field-hint">
        Plaques de 15 × 15 cm : pièces de 145 × 145 mm, avec marge d’impression.
        Une plaque couvre {((145 * scale) / 1000).toLocaleString("fr-FR")} m de
        côté.
      </p>
      {bbox && !issue ? (
        <p className="assembly-proposal">
          {count} plaque{count > 1 ? "s" : ""} pour couvrir la sélection. Les
          bords du plan s’étendent jusqu’à des plaques entières. Maquette
          assemblée : {widthCm.toLocaleString("fr-FR")} ×{" "}
          {depthCm.toLocaleString("fr-FR")} cm.
        </p>
      ) : null}
      <button
        className="button button-secondary button-full"
        disabled={!bbox || !!issue}
        onClick={() => {
          useSceneStore.getState().setProfile(profile);
          void useAssemblyStore
            .getState()
            .start(scale, manualDatum ? datum : undefined);
        }}
      >
        Créer un projet par plaques
      </button>
      {last ? (
        <button
          className="button button-quiet button-full"
          onClick={() =>
            void useAssemblyStore
              .getState()
              .open(last)
              .catch((err) =>
                useAssemblyStore.setState({
                  error:
                    err instanceof Error ? err.message : "Reprise impossible.",
                }),
              )
          }
        >
          Reprendre le dernier projet
        </button>
      ) : null}
      {issue || error ? (
        <p className="field-hint warning" role="alert">
          {issue || error}
        </p>
      ) : null}
    </div>
  );
}

export function AssemblyPanel() {
  const project = useAssemblyStore((s) => s.project)!;
  const cached = useAssemblyStore((s) => s.cached);
  const transient = useAssemblyStore((s) => s.transient);
  const busy = useAssemblyStore((s) => s.busy);
  const error = useAssemblyStore((s) => s.error);
  const notice = useAssemblyStore((s) => s.notice);
  const planPersistent = useAssemblyStore((s) => s.planPersistent);
  const model = useMapStore((s) => s.model);
  const status = useMapStore((s) => s.status);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const active = project.activeCell ?? project.cells[0];
  const key = cellKey(active);
  const hasData =
    cached.includes(key) ||
    (transient?.projectId === project.id && transient.key === key);
  const minCol = Math.min(...project.cells.map((c) => c.col)),
    maxCol = Math.max(...project.cells.map((c) => c.col));
  const minRow = Math.min(...project.cells.map((c) => c.row)),
    maxRow = Math.max(...project.cells.map((c) => c.row));
  const ready = status === "done" && !!model;
  const stem = `printmap-${project.id}-C${active.col}-L${active.row}`;
  const download = async (format: "stl" | "3mf") => {
    if (!model || !ready) return;
    setExporting(true);
    setExportError("");
    try {
      validateExportLayout(model, { cols: 1, rows: 1 });
      if (format === "stl")
        await exportToSTL(model, `${stem}.stl`, { cols: 1, rows: 1 });
      else
        downloadBlob(
          new Blob(
            [
              await create3MFBuffer(model, model.colors, {
                ...model,
                sources: [
                  ...model.sources,
                  `Projet ${project.id} · ${cellLabel(active)} · échelle 1:${project.scale} · datum ${project.elevationDatumM} m · nord +Y`,
                ],
              }),
            ],
            { type: "model/3mf" },
          ),
          `${stem}.3mf`,
        );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export impossible.");
    } finally {
      setExporting(false);
    }
  };
  const backup = async () => {
    try {
      downloadBlob(
        new Blob([await useAssemblyStore.getState().cellBackup()], {
          type: "application/json",
        }),
        `${stem}.printmap.json`,
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Enregistrement impossible.",
      );
    }
  };
  return (
    <aside
      className="side-panel assembly-panel"
      aria-label="Projet par plaques"
    >
      <section className="workflow-section">
        <span className="stage-eyebrow">MAQUETTE ÉVOLUTIVE</span>
        <h2>{project.name}</h2>
        {!planPersistent ? (
          <p className="field-hint warning" role="status">
            Le plan reste en mémoire : le stockage du navigateur est
            indisponible. Cliquez sur « Enregistrer » pour le conserver dans un
            fichier avant de fermer la page.
          </p>
        ) : null}
        <p className="field-hint">
          Échelle fixe{" "}
          <strong>1:{project.scale.toLocaleString("fr-FR")}</strong> · pièces de{" "}
          <strong>145 × 145 mm</strong> pour plateaux de 15 × 15 cm.
        </p>
        <p className="field-hint">
          Les dimensions, le relief et les réglages restent communs à toutes les
          plaques. Ajouter une voisine conserve les anciennes.
        </p>
        <p className="field-hint">
          Les bords du terrain partagent leurs altitudes. Les bâtiments coupés
          et les assises estimées séparément peuvent demander une vérification
          du raccord.
        </p>
        {project.elevationDatumM !== null ? (
          <p className="field-hint">
            Référence du socle figée à {project.elevationDatumM} m.
          </p>
        ) : null}
        <div className="assembly-count">
          <strong>{project.cells.length} plaques au plan</strong>
          <span>{cached.length} avec données locales</span>
        </div>
        <p className="field-hint">
          Encombrement du plan :{" "}
          {((maxCol - minCol + 1) * 14.5).toLocaleString("fr-FR")} ×{" "}
          {((maxRow - minRow + 1) * 14.5).toLocaleString("fr-FR")} cm.
        </p>
        <p className="assembly-north">↑ Nord · sélectionnez une plaque</p>
        <div className="assembly-grid-scroll">
          <div
            className="assembly-grid"
            role="group"
            aria-label="Plan des plaques"
            style={{
              gridTemplateColumns: `repeat(${maxCol - minCol + 1}, 64px)`,
              gridTemplateRows: `repeat(${maxRow - minRow + 1}, 66px)`,
            }}
          >
            {project.cells.map((cell) => (
              <button
                key={cellKey(cell)}
                aria-label={`Plaque ${cell.col}, ${cell.row}`}
                aria-pressed={cellKey(cell) === key}
                className={`assembly-cell ${cached.includes(cellKey(cell)) ? "has-data" : ""}`}
                style={{
                  gridColumn: cell.col - minCol + 1,
                  gridRow: maxRow - cell.row + 1,
                }}
                onClick={() => void useAssemblyStore.getState().select(cell)}
              >
                <strong>{cellLabel(cell)}</strong>
                <small>
                  {cellKey(cell) === key && ready
                    ? "Prête"
                    : cached.includes(cellKey(cell))
                      ? "Données"
                      : "À charger"}
                </small>
              </button>
            ))}
          </div>
        </div>
        <div className="assembly-legend">
          <span>□ À charger</span>
          <span>▣ Données disponibles</span>
        </div>
        <h3>Agrandir depuis {cellLabel(active)}</h3>
        <div
          className="assembly-neighbors"
          role="group"
          aria-label="Ajouter une plaque voisine"
        >
          {(
            [
              { direction: "north", label: "Ajouter en haut", icon: "↑" },
              { direction: "west", label: "Ajouter à gauche", icon: "←" },
              { direction: "east", label: "Ajouter à droite", icon: "→" },
              { direction: "south", label: "Ajouter en bas", icon: "↓" },
            ] as const
          ).map((item) => (
            <button
              key={item.direction}
              className={`button button-secondary ${item.direction}`}
              disabled={busy || exporting}
              onClick={() =>
                void useAssemblyStore.getState().add(item.direction)
              }
            >
              {item.icon} {item.label}
            </button>
          ))}
        </div>
        <p className="field-hint">
          Une plaque à la fois, jusqu’à 100 plaques par projet. Les coordonnées
          C / L restent fixes, même à gauche ou au sud.
        </p>
      </section>
      <section className="workflow-section">
        <h2>Plaque {cellLabel(active)}</h2>
        <p className="field-hint">
          {ready
            ? "Prête à imprimer"
            : hasData
              ? "Données disponibles dans ce navigateur"
              : "Données à charger"}
          . Les autres plaques restent sur disque.
        </p>
        <button
          className="button button-primary button-full"
          disabled={busy || exporting}
          onClick={() => void useAssemblyStore.getState().load()}
        >
          {busy
            ? "Préparation de cette plaque…"
            : hasData
              ? "Construire cette plaque"
              : "Charger et construire cette plaque"}
        </button>
        {hasData ? (
          <>
            <button
              className="button button-secondary button-full"
              disabled={busy || exporting}
              onClick={() =>
                void useAssemblyStore.getState().load({ refresh: true })
              }
            >
              Actualiser les données de cette plaque
            </button>
            <p className="field-hint">
              Recherche les sources disponibles aujourd’hui pour cette plaque.
              Le plan, l’échelle et les raccords du terrain restent fixes.
            </p>
          </>
        ) : null}
        {busy && status !== "processing" ? (
          <button
            className="button button-quiet button-full"
            onClick={() => useAssemblyStore.getState().cancel()}
          >
            Annuler
          </button>
        ) : null}
        <button
          className="button button-quiet button-full"
          onClick={() => {
            useAppStore.getState().setViewMode("map");
            useAppStore.getState().setSettingsPanelOpen(false);
          }}
        >
          Voir le plan sur la carte
        </button>
        {notice ? (
          <p className="field-hint" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="field-hint warning" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="button button-primary button-full"
          disabled={!ready || busy || exporting}
          onClick={() => void download("3mf")}
        >
          {exporting ? "Export en cours…" : "Télécharger le 3MF"}
        </button>
        <button
          className="button button-secondary button-full"
          disabled={!ready || busy || exporting}
          onClick={() => void download("stl")}
        >
          Télécharger le STL
        </button>
        <button
          className="button button-quiet button-full"
          disabled={!hasData || busy}
          onClick={() => void backup()}
        >
          Enregistrer les données de cette plaque
        </button>
        {exportError ? (
          <p className="field-hint warning" role="alert">
            {exportError}
          </p>
        ) : null}
        <p className="field-hint">
          « Enregistrer » conserve le plan. Sauvegardez aussi les données de
          chaque plaque pour les déplacer sur un autre ordinateur. Les exports
          portent les mêmes repères C / L que le plan ; nord vers +Y.
        </p>
        <button
          className="button button-quiet button-full"
          disabled={busy || exporting}
          onClick={() => useAssemblyStore.getState().close()}
        >
          Fermer le projet par plaques
        </button>
      </section>
    </aside>
  );
}
