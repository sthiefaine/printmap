"use client";
import { useSceneStore, type RoadFilter } from "@/store/use-scene-store";
import { FeatureSection } from "./FeatureSection";
import { SliderInput } from "./SliderInput";
import { ToggleSwitch } from "./ToggleSwitch";
function SurfaceLevelControl({
  value,
  onChange,
  limit = 0.8,
}: {
  value: number;
  onChange: (value: number) => void;
  limit?: number;
}) {
  return (
    <div className="surface-level-control">
      <button
        className="surface-level-button"
        aria-pressed={value === 0}
        onClick={() => onChange(0)}
      >
        Au niveau du terrain <span>{value === 0 ? "✓" : "0 mm"}</span>
      </button>
      <SliderInput
        label="Décalage vertical"
        value={value}
        onChange={onChange}
        min={-limit}
        max={limit}
        step={0.1}
        unit=" mm"
      />
      <p className="field-hint">
        0 mm : surface au niveau du sol. Valeur négative : gravure ; positive :
        relief.
      </p>
    </div>
  );
}
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
          label="Toitures 3D disponibles"
        />
        <p className="field-hint">
          Empreintes, cours et hauteurs décrivent les volumes. Elles ne
          décrivent pas les façades : fenêtres, balcons et ornements absents des
          données ne sont pas inventés. Les hauteurs manquantes sont estimées et
          signalées.
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
            aria-label="Réseau visible"
            value={f.roads.filter}
            onChange={(e) =>
              update("roads", {
                filter: e.target.value as RoadFilter,
                footpathsEnabled: e.target.value === "all",
              })
            }
          >
            <option value="major">Axes principaux</option>
            <option value="minor">Axes, rues et places piétonnes</option>
            <option value="all">Rues, allées et chemins</option>
          </select>
        </label>
        <button
          className="button button-quiet"
          aria-pressed={f.roads.filter === "all" && f.roads.footpathsEnabled}
          onClick={() =>
            update("roads", { filter: "all", footpathsEnabled: true })
          }
        >
          Afficher allées et escaliers
        </button>
        <SurfaceLevelControl
          value={f.roads.heightMm}
          onChange={(heightMm) => update("roads", { heightMm })}
          limit={1.2}
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
          au seuil d’impression. Les allées des parcs et chemins sont inclus
          avec le réseau complet ; les marches cartographiées sont adaptées à
          l’échelle de la pièce.
        </p>
      </FeatureSection>
      <FeatureSection
        label="Lacs, rivières et mer"
        enabled={f.water.enabled}
        onToggle={(enabled) => update("water", { enabled })}
        color={f.water.color}
        onColorChange={(color) => update("water", { color })}
      >
        <SurfaceLevelControl
          value={f.water.heightMm}
          onChange={(heightMm) => update("water", { heightMm })}
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
        <SurfaceLevelControl
          value={f.parks.heightMm}
          onChange={(heightMm) => update("parks", { heightMm })}
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
        <SurfaceLevelControl
          value={f.sand.heightMm}
          onChange={(heightMm) => update("sand", { heightMm })}
        />
      </FeatureSection>
      <FeatureSection
        label="Pontons et ponts"
        enabled={f.piers.enabled}
        onToggle={(enabled) => update("piers", { enabled })}
        color={f.piers.color}
        onColorChange={(color) => update("piers", { color })}
      >
        <SliderInput
          label="Surépaisseur des pontons"
          value={f.piers.heightMm}
          onChange={(heightMm) => update("piers", { heightMm })}
          min={0.12}
          max={1.2}
          step={0.04}
          unit=" mm"
          decimals={2}
        />
        <p className="field-hint">
          Les ponts disposant de dimensions sont reconstruits à partir de
          celles-ci. Les contours seuls restent posés sur le terrain : ils ne
          décrivent pas les arches ni les ouvertures d’un relevé 3D complet.
        </p>
      </FeatureSection>
    </div>
  );
}
