"use client";
import { useState, type ReactNode } from "react";
import { useAppStore } from "@/store/app-store";
import { bboxDimensions } from "@/lib/data/bbox";
import {
  BED_MARGIN_MM,
  BED_PRESETS,
  LAYER_NAMES,
  MAX_PLATES_PER_SIDE,
  computeLayout,
  tileLabel,
  type LayerId,
  type Layout,
  type ModelSettings,
} from "@/lib/model/settings";
import { exportModel, type ExportFormat } from "@/lib/export/files";
import { CitySearch } from "./CitySearch";

const fr = (value: number, digits = 0) =>
  value.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

function Section({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line px-5 py-5">
      <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold">
        <span className="font-mono text-xs text-accent">{step}</span>
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Keeps what is being typed, and only commits valid numbers. */
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  // The value changed elsewhere (preset, mode switch): show it, unless it is
  // simply what is being typed ("1." must not snap back to "1").
  if (seen !== value) {
    setSeen(value);
    if (Number(text) !== value) setText(String(value));
  }
  const commit = (raw: string) => {
    const parsed = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(parsed))
      return setText(String(value));
    const clamped = Math.min(max, Math.max(min, parsed));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          className="w-20 rounded-md border border-line bg-white px-2 py-1 text-right tabular-nums"
          value={text}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = Number(event.target.value);
            if (
              event.target.value !== "" &&
              Number.isFinite(parsed) &&
              parsed >= min &&
              parsed <= max
            )
              onChange(parsed);
          }}
          onBlur={(event) => commit(event.target.value)}
        />
        {unit ? <span className="w-7 text-xs text-muted">{unit}</span> : null}
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{format(value)}</span>
      </span>
      <input
        type="range"
        className="mt-1 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const button =
    "h-8 w-8 rounded-md border border-line bg-white text-lg leading-none hover:bg-panel";
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <button
          className={button}
          aria-label={`Moins de ${label.toLowerCase()}`}
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <span className="w-6 text-center font-semibold tabular-nums">
          {value}
        </span>
        <button
          className={button}
          aria-label={`Plus de ${label.toLowerCase()}`}
          disabled={value >= MAX_PLATES_PER_SIDE}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Layer({
  layer,
  enabled,
  onToggle,
  children,
}: {
  layer: LayerId;
  enabled: boolean;
  onToggle?: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  const color = useAppStore((s) => s.settings.colors[layer]);
  const colors = useAppStore((s) => s.settings.colors);
  const patch = useAppStore((s) => s.patch);
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {onToggle ? (
          <input
            type="checkbox"
            className="h-4 w-4 accent-green"
            checked={enabled}
            aria-label={`Inclure : ${LAYER_NAMES[layer]}`}
            onChange={(event) => onToggle(event.target.checked)}
          />
        ) : null}
        <span className="flex-1 font-medium">{LAYER_NAMES[layer]}</span>
        <input
          type="color"
          value={color}
          aria-label={`Couleur : ${LAYER_NAMES[layer]}`}
          onChange={(event) =>
            patch({ colors: { ...colors, [layer]: event.target.value } })
          }
        />
      </div>
      {enabled && children ? (
        <div className="mt-2.5 space-y-2.5">{children}</div>
      ) : null}
    </div>
  );
}

const offsetText = (value: number) =>
  value === 0
    ? "à niveau"
    : `${value < 0 ? "gravé" : "en relief"} ${fr(Math.abs(value), 1)} mm`;

function Plan({ layout }: { layout: Layout }) {
  const { cols, rows, tileWidthMm: tw, tileDepthMm: td } = layout;
  const unit = Math.min(260 / (cols * tw), 150 / (rows * td));
  const w = cols * tw * unit,
    h = rows * td * unit;
  return (
    <svg
      viewBox={`-1 -1 ${w + 2} ${h + 2}`}
      width={w + 2}
      height={h + 2}
      className="mx-auto block"
      role="img"
      aria-label={`Plan : ${cols} colonnes, ${rows} rangées, nord en haut`}
    >
      {Array.from({ length: cols * rows }, (_, index) => {
        const c = index % cols,
          r = Math.floor(index / cols);
        return (
          <g key={index}>
            <rect
              x={c * tw * unit}
              y={r * td * unit}
              width={tw * unit}
              height={td * unit}
              fill="#fff"
              stroke="#3f6651"
              strokeWidth={1.2}
            />
            {tw * unit > 22 && td * unit > 14 ? (
              <text
                x={(c + 0.5) * tw * unit}
                y={(r + 0.5) * td * unit + 4}
                textAnchor="middle"
                fontSize={11}
                fill="#3f6651"
              >
                {tileLabel(c, r)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function download(filename: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function Panel() {
  const bbox = useAppStore((s) => s.bbox);
  const settings = useAppStore((s) => s.settings);
  const data = useAppStore((s) => s.data);
  const model = useAppStore((s) => s.model);
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const refining = useAppStore((s) => s.refining);
  const patch = useAppStore((s) => s.patch);
  const store = useAppStore.getState;
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const dims = bbox ? bboxDimensions(bbox) : null;
  const layout = dims
    ? computeLayout(dims.widthM, dims.heightM, settings)
    : null;
  const busy = status === "fetching" || status === "building";
  const usable = `${settings.bedWidthMm - 2 * BED_MARGIN_MM} × ${settings.bedDepthMm - 2 * BED_MARGIN_MM} mm`;
  const preset = BED_PRESETS.find(
    (p) => p.w === settings.bedWidthMm && p.d === settings.bedDepthMm,
  );
  const plates = layout ? layout.cols * layout.rows : 1;
  const set =
    <K extends keyof ModelSettings>(key: K) =>
    (value: ModelSettings[K]) =>
      patch({ [key]: value } as Partial<ModelSettings>);

  const save = async (format: ExportFormat) => {
    if (!model) return;
    setExporting(format);
    try {
      const file = await exportModel(model, settings, format, "maquette");
      download(file.filename, file.bytes);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section step="1" title="Choisir la zone">
          <CitySearch />
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-lg border border-ink bg-white px-3 py-1.5 font-medium hover:bg-panel"
              onClick={() => {
                store().set({
                  view: "map",
                  drawRequest: store().drawRequest + 1,
                });
              }}
            >
              ▭ Dessiner un rectangle
            </button>
            {[500, 1000, 2000].map((side) => (
              <button
                key={side}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 hover:bg-panel"
                title={`Carré de ${side >= 1000 ? `${side / 1000} km` : `${side} m`} au centre de la carte`}
                onClick={() => store().selectSquare(side)}
              >
                {side >= 1000 ? `${side / 1000} km` : `${side} m`}
              </button>
            ))}
          </div>
          {dims ? (
            <p className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-[13px]">
              <span>
                Zone :{" "}
                <b>
                  {fr(dims.widthM)} × {fr(dims.heightM)} m
                </b>
              </span>
              <button
                className="text-muted underline"
                onClick={() => store().setBbox(null)}
              >
                Effacer
              </button>
            </p>
          ) : (
            <p className="text-[13px] text-muted">
              Cliquez deux coins opposés sur la carte, ou prenez un carré centré
              sur la vue.
            </p>
          )}
        </Section>

        <Section step="2" title="Imprimante et taille">
          <label className="block">
            <span className="mb-1 block text-[13px]">
              Plateau de l’imprimante
            </span>
            <select
              className="w-full rounded-lg border border-line bg-white px-2.5 py-2"
              value={preset ? `${preset.w}x${preset.d}` : "custom"}
              onChange={(event) => {
                const [w, d] = event.target.value.split("x").map(Number);
                if (w && d) patch({ bedWidthMm: w, bedDepthMm: d });
              }}
            >
              {BED_PRESETS.map((p) => (
                <option key={p.name} value={`${p.w}x${p.d}`}>
                  {p.name}
                </option>
              ))}
              {preset ? null : <option value="custom">Sur mesure</option>}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <NumberField
              label="Largeur"
              unit="mm"
              min={60}
              max={1000}
              value={settings.bedWidthMm}
              onChange={set("bedWidthMm")}
            />
            <NumberField
              label="Prof."
              unit="mm"
              min={60}
              max={1000}
              value={settings.bedDepthMm}
              onChange={set("bedDepthMm")}
            />
          </div>
          <p className="text-xs text-muted">
            {BED_MARGIN_MM} mm de marge par bord : chaque pièce tient dans{" "}
            {usable}.
          </p>

          <div
            className="grid grid-cols-2 rounded-lg bg-white p-1 text-[13px]"
            role="group"
            aria-label="Façon de fixer la taille"
          >
            {(
              [
                ["grid", "Remplir des plaques"],
                ["custom", "Taille précise"],
              ] as const
            ).map(([mode, text]) => (
              <button
                key={mode}
                aria-pressed={settings.sizeMode === mode}
                className={`rounded-md px-2 py-1.5 ${settings.sizeMode === mode ? "bg-green font-medium text-white" : "hover:bg-panel"}`}
                onClick={() => {
                  // Switching keeps the current size and grid.
                  if (mode === "custom" && layout)
                    patch({
                      sizeMode: mode,
                      longSideMm: Math.round(
                        Math.max(layout.widthMm, layout.depthMm),
                      ),
                    });
                  else if (layout)
                    patch({
                      sizeMode: mode,
                      cols: layout.cols,
                      rows: layout.rows,
                    });
                  else patch({ sizeMode: mode });
                }}
              >
                {text}
              </button>
            ))}
          </div>
          {settings.sizeMode === "grid" ? (
            <>
              <Stepper
                label="Colonnes"
                value={settings.cols}
                onChange={set("cols")}
              />
              <Stepper
                label="Rangées"
                value={settings.rows}
                onChange={set("rows")}
              />
            </>
          ) : (
            <NumberField
              label="Grand côté de la maquette"
              unit="mm"
              min={30}
              max={3000}
              value={settings.longSideMm}
              onChange={set("longSideMm")}
            />
          )}
          {layout ? (
            <div className="rounded-lg bg-white p-3">
              <Plan layout={layout} />
              <p className="mt-2.5 text-center text-[13px]">
                <b>
                  {plates === 1
                    ? "1 pièce"
                    : `${plates} plaques de ${fr(layout.tileWidthMm)} × ${fr(layout.tileDepthMm)} mm`}
                </b>
                <br />
                Maquette {fr(layout.widthMm)} × {fr(layout.depthMm)} mm · 1:
                {fr(Math.round(layout.scale / 10) * 10)}
                <br />
                <span className="text-muted">
                  10 m réels = {fr(layout.mmPerM * 10, 1)} mm imprimés
                </span>
              </p>
              {layout.mmPerM * 10 < 1.2 ? (
                <p className="mt-2 text-xs text-accent">
                  À cette échelle les bâtiments seront très petits : ajoutez des
                  plaques ou réduisez la zone.
                </p>
              ) : null}
            </div>
          ) : null}
          {plates > 1 ? (
            <>
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-green"
                  checked={settings.connectors}
                  onChange={(event) =>
                    patch({ connectors: event.target.checked })
                  }
                />
                <span>
                  Clés d’assemblage
                  <span className="block text-xs text-muted">
                    Logements papillon sous les joints ; les clés s’impriment à
                    part et verrouillent les plaques entre elles.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-green"
                  checked={settings.labels}
                  onChange={(event) => patch({ labels: event.target.checked })}
                />
                <span>
                  Numéro gravé sous chaque plaque
                  <span className="block text-xs text-muted">
                    Colonne-rangée, comme sur le plan.
                  </span>
                </span>
              </label>
            </>
          ) : null}
        </Section>

        <Section step="3" title="Contenu de la maquette">
          <Layer
            layer="buildings"
            enabled={settings.buildings}
            onToggle={set("buildings")}
          >
            <Slider
              label="Hauteur"
              min={0.5}
              max={3}
              step={0.1}
              value={settings.buildingScale}
              format={(v) => (v === 1 ? "réelle" : `× ${fr(v, 1)}`)}
              onChange={set("buildingScale")}
            />
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-green"
                checked={settings.roofs}
                onChange={(event) => patch({ roofs: event.target.checked })}
              />
              <span>
                Toits en pente
                <span className="block text-xs text-muted">
                  Là où OpenStreetMap décrit leur forme ; les autres restent
                  plats.
                </span>
              </span>
            </label>
          </Layer>
          <Layer layer="roads" enabled={settings.roads} onToggle={set("roads")}>
            <select
              className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-[13px]"
              aria-label="Routes affichées"
              value={settings.roadLevel}
              onChange={(event) =>
                patch({
                  roadLevel: event.target.value as ModelSettings["roadLevel"],
                })
              }
            >
              <option value="major">Grands axes seulement</option>
              <option value="streets">Axes et rues</option>
              <option value="all">Tout, y compris allées et chemins</option>
            </select>
            <Slider
              label="Surface"
              min={-1}
              max={1}
              step={0.2}
              value={settings.roadOffsetMm}
              format={offsetText}
              onChange={set("roadOffsetMm")}
            />
            <Slider
              label="Largeur"
              min={0.5}
              max={2.5}
              step={0.1}
              value={settings.roadWidthScale}
              format={(v) => (v === 1 ? "réelle" : `× ${fr(v, 1)}`)}
              onChange={set("roadWidthScale")}
            />
          </Layer>
          <Layer layer="water" enabled={settings.water} onToggle={set("water")}>
            <Slider
              label="Surface"
              min={-2}
              max={1}
              step={0.2}
              value={settings.waterOffsetMm}
              format={offsetText}
              onChange={set("waterOffsetMm")}
            />
          </Layer>
          <Layer layer="green" enabled={settings.green} onToggle={set("green")}>
            <Slider
              label="Surface"
              min={-1}
              max={1}
              step={0.2}
              value={settings.greenOffsetMm}
              format={offsetText}
              onChange={set("greenOffsetMm")}
            />
          </Layer>
          <Layer layer="base" enabled>
            <Slider
              label="Épaisseur"
              min={1}
              max={10}
              step={0.2}
              value={settings.baseMm}
              format={(v) => `${fr(v, 1)} mm`}
              onChange={set("baseMm")}
            />
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-green"
                checked={settings.relief}
                onChange={(event) => patch({ relief: event.target.checked })}
              />
              <span>Relief du terrain</span>
            </label>
            {settings.relief ? (
              <Slider
                label="Amplification du relief"
                min={0.5}
                max={4}
                step={0.1}
                value={settings.reliefScale}
                format={(v) => (v === 1 ? "réel" : `× ${fr(v, 1)}`)}
                onChange={set("reliefScale")}
              />
            ) : null}
          </Layer>
          <Slider
            label="Plus petit détail imprimé"
            min={0.4}
            max={1.6}
            step={0.1}
            value={settings.minFeatureMm}
            format={(v) => `${fr(v, 1)} mm`}
            onChange={set("minFeatureMm")}
          />
          <p className="text-xs text-muted">
            0,8 mm convient à une buse de 0,4 mm. Les couleurs servent à
            l’aperçu et à l’export 3MF multi-filament.
          </p>
        </Section>

        {model && data ? (
          <Section step="i" title="Cette maquette">
            <ul className="space-y-1 text-[13px]">
              <li>
                {fr(model.layout.widthMm)} × {fr(model.layout.depthMm)} ×{" "}
                {fr(model.heightMm, 1)} mm · {fr(model.stats.volumeCm3)} cm³ de
                matière pleine
              </li>
              <li>
                {fr(model.stats.buildings)} bâtiments
                {model.stats.estimatedHeights
                  ? `, dont ${fr(model.stats.estimatedHeights)} de hauteur estimée`
                  : ""}
              </li>
              {settings.buildings && settings.roofs ? (
                <li>
                  {model.stats.roofs
                    ? `${fr(model.stats.roofs)} toits en pente`
                    : data.detailed
                      ? "Aucun toit en pente décrit dans OpenStreetMap ici"
                      : refining
                        ? "Toits en pente : données détaillées en cours de chargement…"
                        : "Toits en pente indisponibles : le serveur détaillé d’OpenStreetMap n’a pas répondu"}
                </li>
              ) : null}
              {model.keys ? (
                <li>
                  {model.keys.count} clés papillon de{" "}
                  {fr(model.keys.thicknessMm, 1)} mm (2 de rechange)
                </li>
              ) : null}
              {[...data.warnings, ...model.warnings].map((warning) => (
                <li key={warning} className="text-accent">
                  {warning}
                </li>
              ))}
            </ul>
            <details className="text-xs text-muted">
              <summary>Sources des données</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {data.sources.map((source) => (
                  <li key={source}>{source}</li>
                ))}
              </ul>
            </details>
          </Section>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-line bg-paper px-5 py-4">
        {error ? (
          <p
            className="rounded-lg bg-accent/10 px-3 py-2 text-[13px] text-accent"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {!data || !model ? (
          <button
            className="w-full rounded-lg bg-green px-4 py-3 font-semibold text-white hover:brightness-110"
            disabled={!bbox || busy}
            onClick={() => void store().generate()}
          >
            {busy
              ? "Préparation…"
              : bbox
                ? "Générer la maquette"
                : "Choisissez d’abord une zone"}
          </button>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(["stl", "3mf"] as const).map((format) => (
                <button
                  key={format}
                  className={`rounded-lg px-3 py-3 font-semibold ${format === "stl" ? "bg-green text-white hover:brightness-110" : "border border-green bg-white text-green hover:bg-panel"}`}
                  disabled={busy || exporting !== null}
                  onClick={() => void save(format)}
                >
                  {exporting === format
                    ? "Préparation…"
                    : `${format.toUpperCase()}${plates > 1 ? ` · ${plates} plaques` : ""}`}
                </button>
              ))}
            </div>
            <p className="text-center text-xs text-muted">
              STL : une matière · 3MF : une pièce par couleur
              {plates > 1 ? " · ZIP avec plan et clés" : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
