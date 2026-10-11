"use client";
import { useMapStore } from "@/store/use-map-store";
export function QualityReport() {
  const model = useMapStore((s) => s.model);
  const report = useMapStore((s) => s.report);
  const isDemo = useMapStore((s) => s.isDemo);
  if (!model) return null;
  const warnings = [
    ...new Set([...(report?.warnings || []), ...model.warnings]),
  ];
  return (
    <details className="quality-report">
      <summary>
        <span className="quality-check" aria-hidden="true">
          ✓
        </span>
        <div>
          <strong>
            {isDemo ? "Modèle de démonstration" : "Modèle construit"}
          </strong>
          <span>
            {model.stats.buildingCount.toLocaleString("fr-FR")} bâtiments ·{" "}
            {model.stats.triangleCount.toLocaleString("fr-FR")} triangles
          </span>
        </div>
        <span>
          {warnings.length
            ? `${warnings.length} remarque${warnings.length > 1 ? "s" : ""}`
            : "Détails"}{" "}
          ⌄
        </span>
      </summary>
      <div className="quality-content">
        <div className="quality-counts">
          <div>
            <strong>{model.stats.buildingCount}</strong>
            <span>Bâtiments</span>
          </div>
          <div>
            <strong>{model.stats.roadCount}</strong>
            <span>Routes</span>
          </div>
          <div>
            <strong>{model.stats.waterCount}</strong>
            <span>Eaux</span>
          </div>
          <div>
            <strong>{model.stats.parkCount}</strong>
            <span>Espaces verts</span>
          </div>
        </div>
        <p>
          {model.dimensions.widthMm.toFixed(1)} ×{" "}
          {model.dimensions.depthMm.toFixed(1)} ×{" "}
          {model.dimensions.heightMm.toFixed(1)} mm ·{" "}
          {(model.stats.volumeMm3 / 1000).toFixed(1)} cm³ ·{" "}
          {model.stats.components} volume{model.stats.components > 1 ? "s" : ""}{" "}
          connecté{model.stats.components > 1 ? "s" : ""}.
        </p>
        <p>
          {model.stats.discardedFeatures} détails retirés ou empreintes non
          exploitables. {model.stats.estimatedHeights} hauteurs estimées.
        </p>
        {report ? (
          <>
            <p>
              <strong>Sources</strong> · {report.sources.join(" · ")}
            </p>
            {report.measuredBuildingCount > 0 ? (
              <p>
                {report.measuredBuildingCount} bâtiments avec hauteur
                renseignée, dont {report.ignBuildingCount} enrichis par IGN.
              </p>
            ) : null}
            {report.elevationSource ? (
              <p>
                Relief : {report.elevationSource}
                {report.elevationResolutionM
                  ? ` · résolution ${report.elevationResolutionM} m`
                  : ""}
              </p>
            ) : null}
            <p>
              Collecte :{" "}
              {new Date(report.fetchedAt).toLocaleString("fr-FR", {
                timeZone: "Europe/Paris",
                dateStyle: "short",
                timeStyle: "short",
              })}
            </p>
          </>
        ) : null}
        {warnings.length ? (
          <ul className="quality-warnings">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <p>
          Les couleurs 3MF distinguent les surfaces ; choisissez vos filaments
          dans le logiciel de tranchage.
        </p>
      </div>
    </details>
  );
}
