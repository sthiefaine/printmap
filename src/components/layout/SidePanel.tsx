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
import type { BBox } from "@/types/osm";

const PEYROU_BBOX: BBox = [43.6099, 3.8677, 43.6131, 3.8745];
const SAINT_ETIENNE_BBOX: BBox = [45.4288, 4.3702, 45.454, 4.406];

function quickZone(
  type:
    "city" | "coast" | "peyrou" | "saint-etienne" | "nearby" | "architecture",
) {
  const store = useMapStore.getState();
  if (type === "city") {
    store.setSelectedCity({
      name: "Montpellier, centre",
      lat: 43.6119,
      lng: 3.8767,
    });
    store.setBbox([43.6074, 3.8705, 43.6164, 3.8829]);
  } else if (type === "coast") {
    store.setSelectedCity({
      name: "Palavas-les-Flots, littoral",
      lat: 43.5285,
      lng: 3.9315,
    });
    store.setBbox([43.5205, 3.9205, 43.5365, 3.9425]);
  } else if (type === "peyrou") {
    store.setSelectedCity({
      name: "Peyrou · Arc et aqueduc",
      lat: 43.6115,
      lng: 3.8711,
    });
    useSceneStore.getState().updateBaseSettings({ topographyEnabled: true });
    useSceneStore.getState().updateFeatureSettings("roads", {
      filter: "all",
      footpathsEnabled: true,
    });
    store.setBbox(PEYROU_BBOX);
  } else if (type === "saint-etienne") {
    store.setSelectedCity({
      name: "Saint-Étienne · centre et Parc Expo",
      lat: (SAINT_ETIENNE_BBOX[0] + SAINT_ETIENNE_BBOX[2]) / 2,
      lng: (SAINT_ETIENNE_BBOX[1] + SAINT_ETIENNE_BBOX[3]) / 2,
    });
    const scene = useSceneStore.getState();
    scene.setProfile("balanced");
    scene.setTileSize(290);
    scene.updateBaseSettings({
      topographyEnabled: true,
      grid: { cols: 2, rows: 2 },
    });
    store.setBbox(SAINT_ETIENNE_BBOX);
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
  const setProfile = useSceneStore((s) => s.setProfile);
  const setSize = useSceneStore((s) => s.setTileSize);
  const updatePrint = useSceneStore((s) => s.updatePrintSettings);
  const [tab, setTab] = useState<"layers" | "base">("layers");
  const dimensions = bbox ? getBboxDimensions(bbox, scale) : null;
  const isPeyrouSelection =
    selectedCity?.name === "Peyrou · Arc et aqueduc" &&
    bbox?.every((coordinate, index) => coordinate === PEYROU_BBOX[index]);
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
        <div className="quick-zones">
          <button onClick={() => quickZone("city")}>Montpellier</button>
          <button onClick={() => quickZone("coast")}>Palavas · littoral</button>
          <button onClick={() => quickZone("peyrou")}>
            Peyrou · Arc et aqueduc
          </button>
          <button onClick={() => quickZone("saint-etienne")}>
            Saint-Étienne · centre et Parc Expo
          </button>
        </div>
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
