"use client";
import { useSceneStore } from "@/store/use-scene-store";
import { useMapStore } from "@/store/use-map-store";
import { SliderInput } from "./SliderInput";
import { ColorPicker } from "./ColorPicker";
import { ToggleSwitch } from "./ToggleSwitch";
export function BaseTab() {
  const settings = useSceneStore((s) => s.modelSettings.base);
  const update = useSceneStore((s) => s.updateBaseSettings);
  const elevationGrid = useMapStore((s) => s.elevationGrid);
  const hasData = useMapStore((s) => !!s.osmData);
  const refreshRelief = useMapStore((s) => s.refreshRelief);
  const status = useMapStore((s) => s.status);
  const busy = status === "fetching" || status === "processing";
  return (
    <div className="settings-stack">
      <SliderInput
        label="Épaisseur du socle"
        value={settings.basePlateThicknessMm}
        onChange={(v) => update({ basePlateThicknessMm: v })}
        min={1}
        max={8}
        step={0.2}
        unit=" mm"
      />
      <div className="inline-field">
        <span>Couleur du socle</span>
        <ColorPicker
          value={settings.baseColor}
          onChange={(baseColor) => update({ baseColor })}
          label="Couleur du socle"
        />
      </div>
      <ToggleSwitch
        checked={settings.topographyEnabled}
        onChange={(topographyEnabled) => {
          update({ topographyEnabled });
          if (topographyEnabled && hasData && !elevationGrid)
            void refreshRelief();
        }}
        label="Relief du terrain"
      />
      {settings.topographyEnabled ? (
        <>
          <SliderInput
            label="Amplification du relief"
            value={settings.elevationExaggeration}
            onChange={(elevationExaggeration) =>
              update({ elevationExaggeration })
            }
            min={0.5}
            max={3}
            step={0.1}
            unit="×"
          />
          {hasData && !elevationGrid ? (
            <div className="settings-stack">
              <p className="field-hint warning">
                Le relief manque dans ces données. Récupérez-le pour retrouver
                les terrasses et variations du terrain en conservant les
                bâtiments et votre zone.
              </p>
              <button
                className="button button-secondary button-full"
                disabled={busy}
                onClick={() => void refreshRelief()}
              >
                Récupérer le relief
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      <ToggleSwitch
        checked={settings.frame.enabled}
        onChange={(enabled) =>
          update({ frame: { ...settings.frame, enabled } })
        }
        label="Bordure du socle"
      />
      {settings.frame.enabled ? (
        <>
          <SliderInput
            label="Largeur de bordure"
            value={settings.frame.thicknessMm}
            onChange={(thicknessMm) =>
              update({ frame: { ...settings.frame, thicknessMm } })
            }
            min={1}
            max={5}
            step={0.2}
            unit=" mm"
          />
          <SliderInput
            label="Hauteur de bordure"
            value={settings.frame.heightMm}
            onChange={(heightMm) =>
              update({ frame: { ...settings.frame, heightMm } })
            }
            min={0.4}
            max={3}
            step={0.2}
            unit=" mm"
          />
        </>
      ) : null}
    </div>
  );
}
