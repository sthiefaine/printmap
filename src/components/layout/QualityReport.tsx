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
  const sources = [...new Set([...(report?.sources || []), ...model.sources])];
  return (
    <details className="quality-report">
      <summary>
        <span className="quality-check" aria-hidden="true">
          ✓
        </span>
        <div>
          <strong>{isDemo ? "Rapport de la démo" : "Rapport du modèle"}</strong>
          <span>
            {model.stats.buildingCount.toLocaleString("fr-FR")} bâtiments ·{" "}
            {warnings.length} remarque{warnings.length > 1 ? "s" : ""}
          </span>
          <span>
            {model.stats.realRoofCount.toLocaleString("fr-FR")} toiture
            {model.stats.realRoofCount === 1 ? " mesurée" : "s mesurées"}
            {model.stats.lidarRoofCount
              ? ` · ${model.stats.lidarRoofCount.toLocaleString("fr-FR")} LiDAR`
              : ""}
            {model.stats.reconstructedBalconyBuildingCount
              ? " · balcons reconstitués"
              : ""}
            {model.stats.documentedFacadeBuildingCount
              ? " · façade reconstituée"
              : ""}
          </span>
        </div>
        <span>Détails ⌄</span>
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
          {model.stats.triangleCount.toLocaleString("fr-FR")} triangles ·{" "}
          {(model.stats.volumeMm3 / 1000).toFixed(1)} cm³ ·{" "}
          {model.stats.components} volume{model.stats.components > 1 ? "s" : ""}{" "}
          connecté{model.stats.components > 1 ? "s" : ""}.
        </p>
        <p>
          {model.stats.discardedFeatures} détails retirés ou empreintes non
          exploitables. {model.stats.estimatedHeights} hauteurs estimées.
        </p>
        <p>
          <strong>Escaliers</strong> · {model.stats.staircaseCount} volée
          {model.stats.staircaseCount > 1 ? "s" : ""} reconstruite
          {model.stats.staircaseCount > 1 ? "s" : ""} et adaptée
          {model.stats.staircaseCount > 1 ? "s" : ""} à l’échelle. Les marches
          trop petites peuvent être regroupées pour rester imprimables.
        </p>
        {model.stats.measuredStructureCount > 0 ? (
          <p>
            <strong>Volumes 3D complets mesurés</strong> ·{" "}
            {model.stats.measuredStructureCount} géométrie
            {model.stats.measuredStructureCount > 1 ? "s" : ""} complète
            {model.stats.measuredStructureCount > 1 ? "s" : ""}.
          </p>
        ) : null}
        {model.stats.reconstructedBalconyBuildingCount ? (
          <p>
            <strong>Arbre Blanc · balcons reconstitués</strong> · plateaux
            visibles dans le LiDAR IGN, complétés par les terrasses et le
            couronnement du relevé municipal. Le volume du noyau, les raccords
            et les épaisseurs sont estimés. Le relevé aérien reste incomplet ;
            les 193 balcons ne sont pas tous relevés. Vérifiez les surplombs et
            les supports dans votre logiciel d’impression.
          </p>
        ) : null}
        {model.stats.documentedFacadeBuildingCount ? (
          <p>
            <strong>Hôtel de Région · façade reconstituée</strong> · deux
            verrières de 21 × 8 m documentées par l’Inventaire régional. La
            position verticale et la profondeur des renfoncements sont estimées
            ; leur relief est adapté à l’impression. Un volume plein reste
            derrière le verre. Cette restitution ne constitue pas un relevé de
            façade.
          </p>
        ) : null}
        {model.stats.reconstructedBridgeCount > 0 ? (
          <p>
            <strong>
              Ponts reconstruits depuis des dimensions ou altitudes
            </strong>{" "}
            · {model.stats.reconstructedBridgeCount} ouvrage
            {model.stats.reconstructedBridgeCount > 1 ? "s" : ""} au profil
            approché. Cette reconstruction ne remplace pas un relevé 3D complet.
          </p>
        ) : null}
        {model.stats.basinRimCount > 0 ? (
          <p>
            <strong>Bordures de bassin</strong> · {model.stats.basinRimCount}{" "}
            contour{model.stats.basinRimCount > 1 ? "s" : ""} reconstitué
            {model.stats.basinRimCount > 1 ? "s" : ""}. Les dimensions non
            renseignées sont estimées ; les détails fins sont adaptés à
            l’impression.
          </p>
        ) : null}
        {model.stats.reconstructedAqueductCount > 0 ? (
          <p>
            <strong>
              {model.stats.reconstructedAqueductCount > 1
                ? "Aqueducs reconstitués"
                : "Aqueduc reconstitué"}
            </strong>{" "}
            · {model.stats.reconstructedAqueductCount} ouvrage
            {model.stats.reconstructedAqueductCount > 1 ? "s" : ""} ·{" "}
            {model.stats.aqueductArchCount} arches (profil documentaire
            approché). Les piles, le tablier et leur raccord au terrain ne
            constituent pas un relevé 3D mesuré.
          </p>
        ) : null}
        <p>
          <strong>Toitures</strong> · {model.stats.realRoofCount} géométries 3D
          mesurées
          {model.stats.lidarRoofCount ? (
            <>
              {" "}
              · {model.stats.lidarRoofCount} reconstructions depuis le LiDAR IGN
            </>
          ) : null}{" "}
          · {model.stats.taggedRoofCount} formes renseignées
          {!isDemo ? " dans OpenStreetMap" : " dans la démo"}.{" "}
          {Math.max(
            0,
            model.stats.buildingCount -
              model.stats.realRoofCount -
              (model.stats.lidarRoofCount ?? 0) -
              (model.stats.reconstructedBalconyBuildingCount ?? 0) -
              model.stats.taggedRoofCount,
          )}{" "}
          volumes sans toiture 3D reconstruite.
        </p>
        {report?.lod2Year ? (
          <p>
            Les toitures 3D mesurées correspondent au relevé {report.lod2Year}.
          </p>
        ) : null}
        {(model.stats.lidarRoofCount ?? 0) > 0 &&
        report?.lidarRoofResolutionM ? (
          <p>
            Toits LiDAR : grille utilisée de{" "}
            {report.lidarRoofMinResolutionM != null &&
            report.lidarRoofMinResolutionM < report.lidarRoofResolutionM
              ? `${report.lidarRoofMinResolutionM.toLocaleString("fr-FR")} à `
              : ""}
            {report.lidarRoofResolutionM.toLocaleString("fr-FR")} m, issue d’une
            source au pas de 0,5 m. Les pentes et volumes sont reconstruits
            depuis la surface ; les façades et parties masquées nécessitent un
            relevé 3D dédié.
          </p>
        ) : null}
        {report?.landmarkRoofBuildingCount ? (
          <p>
            Données acquises pour {report.landmarkRoofBuildingCount} repères :
            grille LiDAR locale de 1 m. Le niveau de détail conservé dépend de
            l’échelle et des réglages d’impression.
          </p>
        ) : null}
        <p>
          Précision : empreintes et hauteurs décrivent le volume des bâtiments.
          Les façades, ouvertures et sculptures demandent des géométries 3D
          dédiées. Les profils documentaires reconstitués sont signalés
          séparément des volumes mesurés ; le relief et les toitures seuls ne
          décrivent pas tous ces détails architecturaux.
        </p>
        {sources.length ? (
          <p>
            <strong>Sources</strong> · {sources.join(" · ")}
          </p>
        ) : null}
        {report ? (
          <>
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
            {report.rioBuildingCount ? (
              <p>
                {report.rioBuildingCount} volumes ajoutés ou enrichis par les
                contours et hauteurs municipaux de Rio (2019).
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
