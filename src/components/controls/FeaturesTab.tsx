"use client";
import { useSceneStore, type RoadFilter } from "@/store/use-scene-store";
import { FeatureSection } from "./FeatureSection";
import { SliderInput } from "./SliderInput";
import { ToggleSwitch } from "./ToggleSwitch";
export function FeaturesTab() {
  const f = useSceneStore((s) => s.modelSettings.features);
  const update = useSceneStore((s) => s.updateFeatureSettings);
  return (
    <div className="layers-stack">
      <FeatureSection
        label="Bâtiments"
        enabled={f.buildings.enabled}
        onToggle={(enabled) => update("buildings", { enabled })}
        color={f.buildings.color}
        onColorChange={(color) =>
          update("buildings", { color, roofColor: color })
        }
        defaultOpen
      >
        <SliderInput
          label="Hauteur des bâtiments"
          value={f.buildings.buildingScale}
          onChange={(buildingScale) => update("buildings", { buildingScale })}
          min={0.5}
          max={3}
          step={0.1}
          unit="×"
        />
        <ToggleSwitch
          checked={f.buildings.roofs}
          onChange={(roofs) => update("buildings", { roofs })}
          label="Toits renseignés dans les données"
        />
        <p className="field-hint">
          Les formes et hauteurs sont conservées. Les hauteurs manquantes sont
          estimées et signalées.
        </p>
      </FeatureSection>
      <FeatureSection
        label="Routes et chemins"
        enabled={f.roads.enabled}
        onToggle={(enabled) => update("roads", { enabled })}
        color={f.roads.color}
        onColorChange={(color) => update("roads", { color })}
      >
        <label className="select-field">
          Réseau visible
          <select
            value={f.roads.filter}
            onChange={(e) =>
              update("roads", {
                filter: e.target.value as RoadFilter,
                footpathsEnabled: e.target.value === "all",
              })
            }
          >
            <option value="major">Axes principaux</option>
            <option value="minor">Axes et rues</option>
            <option value="all">Rues et chemins</option>
          </select>
        </label>
        <SliderInput
          label="Surépaisseur"
          value={f.roads.heightMm}
          onChange={(heightMm) => update("roads", { heightMm })}
          min={0.12}
          max={1.2}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
        <SliderInput
          label="Largeur du réseau"
          value={f.roads.widthMultiplier}
          onChange={(widthMultiplier) => update("roads", { widthMultiplier })}
          min={0.7}
          max={2}
          step={0.1}
          unit="×"
        />
        <p className="field-hint">
          Les routes souterraines sont retirées. Les lignes fines sont élargies
          au seuil d’impression.
        </p>
      </FeatureSection>
      <FeatureSection
        label="Lacs, rivières et mer"
        enabled={f.water.enabled}
        onToggle={(enabled) => update("water", { enabled })}
        color={f.water.color}
        onColorChange={(color) => update("water", { color })}
      >
        <SliderInput
          label="Surépaisseur de l’eau"
          value={f.water.heightMm}
          onChange={(heightMm) => update("water", { heightMm })}
          min={0.12}
          max={0.8}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
        <p className="field-hint">
          Les surfaces et cours d’eau identifiés sont préservés. Le rapport
          indique la couverture du littoral.
        </p>
      </FeatureSection>
      <FeatureSection
        label="Parcs et jardins"
        enabled={f.parks.enabled}
        onToggle={(enabled) => update("parks", { enabled })}
        color={f.parks.color}
        onColorChange={(color) => update("parks", { color })}
      >
        <SliderInput
          label="Surépaisseur des espaces verts"
          value={f.parks.heightMm}
          onChange={(heightMm) => update("parks", { heightMm })}
          min={0.12}
          max={0.8}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
        <p className="field-hint">
          Les espaces verts sont représentés comme des surfaces lisibles, sans
          ajouter d’arbres inventés.
        </p>
      </FeatureSection>
      <FeatureSection
        label="Plages et sable"
        enabled={f.sand.enabled}
        onToggle={(enabled) => update("sand", { enabled })}
        color={f.sand.color}
        onColorChange={(color) => update("sand", { color })}
      >
        <SliderInput
          label="Surépaisseur"
          value={f.sand.heightMm}
          onChange={(heightMm) => update("sand", { heightMm })}
          min={0.12}
          max={0.8}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
      </FeatureSection>
      <FeatureSection
        label="Pontons et quais"
        enabled={f.piers.enabled}
        onToggle={(enabled) => update("piers", { enabled })}
        color={f.piers.color}
        onColorChange={(color) => update("piers", { color })}
      >
        <SliderInput
          label="Surépaisseur"
          value={f.piers.heightMm}
          onChange={(heightMm) => update("piers", { heightMm })}
          min={0.12}
          max={1.2}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
      </FeatureSection>
    </div>
  );
}
