"use client";
import { useState } from "react";
import { useMapStore } from "@/store/use-map-store";
import {
  useSceneStore,
  PRINT_PROFILES,
  type PrintProfile,
} from "@/store/use-scene-store";
import { useAppStore } from "@/store/use-app-store";
import { CitySearch } from "@/components/map/CitySearch";
import { SelectionTools } from "@/components/map/SelectionTools";
import { BaseTab } from "@/components/controls/BaseTab";
import { FeaturesTab } from "@/components/controls/FeaturesTab";
import { ExportPanel } from "@/components/controls/ExportPanel";
import { GenerateButton } from "@/components/controls/GenerateButton";
import { SliderInput } from "@/components/controls/SliderInput";
import { getBboxDimensions } from "@/lib/mesh/base-plate-mesh";
import { bboxDimensions } from "@/lib/data/bbox";
import {
  SAINT_ETIENNE_STADIUM_BBOX,
  SAINT_ETIENNE_TWO_PLATE_BBOX,
  salonPrintLayouts,
  salonLayoutSettings,
  salonLayoutDimensions,
  type SalonPrintLayout,
} from "@/lib/print-layout";
import {
  CITY_PRESETS,
  CITY_SHORTCUTS,
  PEYROU_BBOX,
  type CityPresetId,
} from "@/lib/city-presets";

function quickZone(type: CityPresetId | "nearby" | "architecture") {
  const store = useMapStore.getState();
  const preset = CITY_PRESETS.find((preset) => preset.id === type);
  if (preset) {
    store.setSelectedCity({
      name: preset.name,
      lat: (preset.bbox[0] + preset.bbox[2]) / 2,
      lng: (preset.bbox[1] + preset.bbox[3]) / 2,
    });
    const scene = useSceneStore.getState();
    if (preset.id === "peyrou") {
      scene.updateBaseSettings({ topographyEnabled: true });
      scene.updateFeatureSettings("roads", {
        filter: "all",
        footpathsEnabled: true,
      });
    }
    if (preset.city === "saint-etienne" || preset.city === "rio") {
      scene.setProfile(type === "saint-etienne-roofs" ? "detail" : "balanced");
      scene.setTileSize(290);
      scene.updateBaseSettings({
        topographyEnabled: true,
        elevationExaggeration: 1,
        grid: { cols: 2, rows: 2 },
        plateSizeMm: 150,
      });
      scene.updateFeatureSettings("buildings", {
        roofs: true,
        buildingScale: 1,
      });
      if (type === "saint-etienne-two-plates") {
        const layout = salonPrintLayouts(preset.bbox)[0];
        useSceneStore.setState({
          tileSize: layout.longSideMm,
          scale: layout.scale,
          modelSettings: salonLayoutSettings(
            useSceneStore.getState().modelSettings,
            layout,
          ),
        });
      }
    }
    store.setBbox([...preset.bbox]);
  } else {
    const city = store.selectedCity || {
      name: "Montpellier",
      lat: 43.6119,
      lng: 3.8767,
    };
    const center =
      type === "architecture" && store.bbox
        ? {
            lat: (store.bbox[0] + store.bbox[2]) / 2,
            lng: (store.bbox[1] + store.bbox[3]) / 2,
          }
        : city;
    const halfSideM = type === "architecture" ? 150 : 500;
    const deltaLat = halfSideM / 111195,
      deltaLng = deltaLat / Math.cos((center.lat * Math.PI) / 180);
    store.setBbox([
      center.lat - deltaLat,
      center.lng - deltaLng,
      center.lat + deltaLat,
      center.lng + deltaLng,
    ]);
  }
  useAppStore.getState().setViewMode("map");
}
export function SidePanel() {
  const bbox = useMapStore((s) => s.bbox);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const status = useMapStore((s) => s.status);
  const isDemo = useMapStore((s) => s.isDemo);
  const loadDemo = useMapStore((s) => s.loadDemo);
  const scale = useSceneStore((s) => s.scale);
  const size = useSceneStore((s) => s.tileSize);
  const profile = useSceneStore((s) => s.profile);
  const print = useSceneStore((s) => s.modelSettings.print);
  const grid = useSceneStore((s) => s.modelSettings.base.grid);
  const setProfile = useSceneStore((s) => s.setProfile);
  const setSize = useSceneStore((s) => s.setTileSize);
  const updatePrint = useSceneStore((s) => s.updatePrintSettings);
  const [tab, setTab] = useState<"layers" | "base">("layers");
  const dimensions = bbox ? getBboxDimensions(bbox, scale) : null;
  const shortcutCity = selectedCity?.name.startsWith("Saint-Étienne")
    ? "saint-etienne"
    : selectedCity?.name.startsWith("Rio de Janeiro")
      ? "rio"
      : selectedCity?.name.startsWith("Montpellier") ||
          selectedCity?.name.startsWith("Peyrou")
        ? "montpellier"
        : null;
  const presets = CITY_PRESETS.filter((preset) => preset.city === shortcutCity);
  const currentPreset = presets.find((preset) =>
    bbox?.every((coordinate, index) => coordinate === preset.bbox[index]),
  );
  const isPeyrouSelection =
    selectedCity?.name === "Peyrou · Arc et aqueduc" &&
    bbox?.every((coordinate, index) => coordinate === PEYROU_BBOX[index]);
  const isTwoPlateCorridor = bbox?.every(
    (coordinate, index) => coordinate === SAINT_ETIENNE_TWO_PLATE_BBOX[index],
  );
  const salonLayouts = bbox?.every(
    (coordinate, index) => coordinate === SAINT_ETIENNE_STADIUM_BBOX[index],
  )
    ? salonPrintLayouts(bbox)
    : null;
  const salonLayoutButton = (layout: SalonPrintLayout) => {
    const active =
      grid.cols === layout.grid.cols &&
      grid.rows === layout.grid.rows &&
      Math.abs(size - layout.longSideMm) < 0.001 &&
      Math.abs(scale - layout.scale) / layout.scale < 0.000001;
    return (
      <button
        key={layout.count}
        className={active ? "selected" : ""}
        aria-pressed={active}
        disabled={status === "fetching" || status === "processing"}
        onClick={() => {
          const scene = useSceneStore.getState();
          useSceneStore.setState({
            tileSize: layout.longSideMm,
            scale: layout.scale,
            modelSettings: salonLayoutSettings(scene.modelSettings, layout),
          });
        }}
      >
        {layout.count} plaques
      </button>
    );
  };
  return (
    <aside className="side-panel" aria-label="Réglages du modèle">
      <section className="workflow-section">
        <div className="section-heading">
          <span className="step-number">01</span>
          <div>
            <h2>Choisir un morceau de ville</h2>
            <p>Un quartier, un paysage, votre endroit.</p>
          </div>
        </div>
        <CitySearch />
        <div
          className="quick-zones"
          role="group"
          aria-label="Raccourcis de villes"
        >
          {CITY_SHORTCUTS.map((shortcut) => (
            <button
              key={shortcut.city}
              aria-pressed={shortcutCity === shortcut.city}
              onClick={() => quickZone(shortcut.preset)}
            >
              {shortcut.label}
            </button>
          ))}
        </div>
        {presets.length > 1 ? (
          <label className="select-field city-framing">
            <span>Cadrage</span>
            <select
              aria-label={`Cadrage de ${CITY_SHORTCUTS.find((city) => city.city === shortcutCity)?.label}`}
              value={currentPreset?.id ?? ""}
              onChange={(event) =>
                quickZone(event.target.value as CityPresetId)
              }
            >
              <option value="" disabled>
                Zone personnalisée
              </option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="selection-actions">
          <SelectionTools />
          <button
            className="button button-quiet"
            onClick={() => quickZone("nearby")}
          >
            Zone de 1 km²
          </button>
          <button
            className="button button-quiet"
            onClick={() => quickZone("architecture")}
          >
            Quartier de 300 m
          </button>
        </div>
        {bbox ? (
          <div className="selection-summary">
            <span className="status-dot" />
            <div>
              <strong>{selectedCity?.name || "Zone sélectionnée"}</strong>
              <span>
                {bboxDimensions(bbox).areaKm2.toFixed(2)} km² · rectangle
                délimité
              </span>
            </div>
            <button
              title="Effacer la sélection"
              aria-label="Effacer la sélection"
              onClick={() => useMapStore.getState().reset()}
            >
              ×
            </button>
          </div>
        ) : (
          <p className="field-hint">
            Choisissez un lieu puis délimitez la zone sur la carte. Jusqu’à 25
            km².
          </p>
        )}
        {isPeyrouSelection ? (
          <p className="field-hint selection-context">
            Arc de triomphe, pont Vialleton, château d’eau et départ de
            l’aqueduc. Relief et allées activés pour cette sélection. L’Arc et
            le château d’eau utilisent le relevé 3D municipal ; les voûtes de
            l’aqueduc sont reconstituées d’après un plan historique, avec des
            dimensions et un placement approchés indiqués dans le rapport.
          </p>
        ) : null}
        {currentPreset?.id === "rio" ? (
          <p className="field-hint selection-context">
            Corcovado, baie de Botafogo, Pain de Sucre et nord de Copacabana.
            Relief activé, sans exagération, et quatre plaques de 15 cm par
            défaut.
          </p>
        ) : null}
        {isTwoPlateCorridor ? (
          <p className="field-hint selection-context">
            Centre, cathédrale Saint-Charles, Cité du Design, Parc Expo et
            Geoffroy-Guichard. Ce cadrage retire Couriot et les quartiers à
            l’ouest pour garder, sur deux plaques, la même échelle que la
            sélection complète sur quatre plaques. Maquette assemblée d’environ
            145 × 290 mm, deux pièces d’environ 145 × 145 mm.
          </p>
        ) : null}
        <GenerateButton />
        <button
          className="demo-link"
          disabled={status === "fetching" || status === "processing"}
          onClick={() => void loadDemo()}
        >
          Essayer une démo sans réseau <span aria-hidden="true">→</span>
        </button>
        {isDemo ? (
          <p className="demo-note">DÉMO SYNTHÉTIQUE · quartier inventé</p>
        ) : null}
      </section>
      <section className="workflow-section">
        <div className="section-heading">
          <span className="step-number">02</span>
          <div>
            <h2>Préparer une belle impression</h2>
            <p>Conserver l’essentiel à la bonne échelle.</p>
          </div>
        </div>
        <label className="size-field">
          <span>Long côté de la pièce</span>
          <div>
            <input
              type="number"
              min={50}
              max={1000}
              step={10}
              value={Math.round(size)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 50 && v <= 1000) setSize(v, bbox);
              }}
            />
            <span>mm</span>
          </div>
        </label>
        <div className="dimension-line">
          <strong>
            {dimensions
              ? `${dimensions.widthMm.toFixed(0)} × ${dimensions.heightMm.toFixed(0)} mm`
              : "Format adapté à votre zone"}
          </strong>
          <span>
            {dimensions
              ? `1:${Math.round(scale).toLocaleString("fr-FR")}`
              : "Proportions géographiques conservées"}
          </span>
        </div>
        {dimensions ? (
          <p className="scale-precision">
            1 m réel ={" "}
            {(1000 / scale).toLocaleString("fr-FR", {
              maximumFractionDigits: 2,
              minimumFractionDigits: 2,
            })}{" "}
            mm imprimé. Pour mieux voir l’architecture, choisissez une zone plus
            petite ou une pièce plus grande.
          </p>
        ) : null}
        {salonLayouts ? (
          <div className="settings-stack">
            <p className="field-hint">
              Maquette de salon · plateau 15 × 15 cm. Chaque plaque mesure au
              maximum 145 mm, avec 5 mm de marge sur le plateau. La zone centre,
              Parc Expo et stade reste la même.
            </p>
            <div className="profiles" role="group" aria-label="Format salon">
              {salonLayouts
                .filter((layout) => layout.count <= 4)
                .map(salonLayoutButton)}
            </div>
            <p className="field-hint">
              {salonLayouts
                .filter((layout) => layout.count <= 4)
                .map((layout) => (
                  <span key={layout.count}>
                    {salonLayoutDimensions(layout)}
                    <br />
                  </span>
                ))}
              2 plaques donnent une maquette plus compacte avec moins de
              détails. 4 plaques agrandissent la même zone de 48 % et conservent
              davantage de petites empreintes imprimables. Relief et bâtiments
              conservent leurs proportions, avec les toits activés.
            </p>
            <button
              className="button button-secondary"
              disabled={status === "fetching" || status === "processing"}
              onClick={() => quickZone("saint-etienne-two-plates")}
            >
              Mieux cadrer pour 2 plaques
            </button>
            <p className="field-hint">
              Garde le centre, le Parc Expo et le stade avec des bâtiments 48 %
              plus grands. Couriot et les quartiers à l’ouest sont exclus de ce
              cadrage.
            </p>
            <details className="advanced-settings">
              <summary>Formats plus grands : 6 ou 9 plaques</summary>
              <div
                className="profiles"
                role="group"
                aria-label="Grands formats salon"
              >
                {salonLayouts
                  .filter((layout) => layout.count > 4)
                  .map(salonLayoutButton)}
              </div>
              <p className="field-hint">
                {salonLayouts
                  .filter((layout) => layout.count > 4)
                  .map((layout) => (
                    <span key={layout.count}>
                      {salonLayoutDimensions(layout)}
                      <br />
                    </span>
                  ))}
                Par rapport à 4 plaques, les détails gagnent 35 % avec 6 plaques
                et 50 % avec 9.
              </p>
            </details>
          </div>
        ) : null}
        <div className="profiles" aria-label="Niveau de détail">
          {(Object.keys(PRINT_PROFILES) as PrintProfile[]).map((id) => (
            <button
              key={id}
              aria-pressed={profile === id}
              className={profile === id ? "selected" : ""}
              onClick={() => setProfile(id)}
            >
              {PRINT_PROFILES[id].label}
            </button>
          ))}
        </div>
        <p className="profile-hint">{PRINT_PROFILES[profile].hint}</p>
        <details className="advanced-settings">
          <summary>
            Résolution et nettoyage{" "}
            <span>{print.minFeatureMm.toFixed(2)} mm</span>
          </summary>
          <div className="settings-stack">
            <SliderInput
              label="Détail minimum imprimable"
              value={print.minFeatureMm}
              onChange={(minFeatureMm) => updatePrint({ minFeatureMm })}
              min={0.2}
              max={1.5}
              step={0.05}
              unit=" mm"
              decimals={2}
            />
            <SliderInput
              label="Petites empreintes : surface minimum"
              value={print.minBuildingAreaMm2}
              onChange={(minBuildingAreaMm2) =>
                updatePrint({ minBuildingAreaMm2 })
              }
              min={0.2}
              max={5}
              step={0.2}
              unit=" mm²"
            />
            <SliderInput
              label="Hauteur lisible minimum"
              value={print.minBuildingHeightMm}
              onChange={(minBuildingHeightMm) =>
                updatePrint({ minBuildingHeightMm })
              }
              min={0.2}
              max={2}
              step={0.1}
              unit=" mm"
            />
            <p className="field-hint">
              0,8 mm convient à un modèle FDM lisible. 0,45 mm demande une
              impression plus fine. Les détails sous ce seuil sont simplifiés ou
              retirés.
            </p>
          </div>
        </details>
        <div className="settings-tabs" role="tablist" aria-label="Réglages">
          <button
            role="tab"
            aria-selected={tab === "layers"}
            aria-controls="layers-panel"
            id="layers-tab"
            onClick={() => setTab("layers")}
          >
            Éléments du paysage
          </button>
          <button
            role="tab"
            aria-selected={tab === "base"}
            aria-controls="base-panel"
            id="base-tab"
            onClick={() => setTab("base")}
          >
            Socle et relief
          </button>
        </div>
        <div
          role="tabpanel"
          id={tab === "layers" ? "layers-panel" : "base-panel"}
          aria-labelledby={tab === "layers" ? "layers-tab" : "base-tab"}
        >
          {tab === "layers" ? <FeaturesTab /> : <BaseTab />}
        </div>
      </section>
      <section className="workflow-section export-section">
        <div className="section-heading">
          <span className="step-number">03</span>
          <div>
            <h2>Passer à l’imprimante</h2>
            <p>Une pièce ou plusieurs tuiles.</p>
          </div>
        </div>
        <ExportPanel />
      </section>
    </aside>
  );
}
