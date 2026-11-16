/* Build a model without the browser, for checks and batch exports:
 *   npm run city -- 43.6065,3.8700,43.6155,3.8824 --cols 2 --rows 2 --out sortie
 * The collected data is cached next to the output for quick re-runs. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BBox, MapData } from "@/types/osm";
import { validateBbox } from "@/lib/data/bbox";
import { collectMapData } from "@/lib/data/collect";
import { buildModel } from "@/lib/model/build";
import { DEFAULT_SETTINGS, type ModelSettings } from "@/lib/model/settings";
import { exportModel, type ExportFormat } from "@/lib/export/files";
import { meshDefect } from "@/lib/model/check";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const flag = (name: string) => args.includes(`--${name}`);
const bbox = validateBbox(
  (args[0] ?? "43.6065,3.8700,43.6155,3.8824").split(",").map(Number),
) as BBox;
const out = option("out") ?? "artifacts/city";
await mkdir(out, { recursive: true });

const cacheFile = join(out, `data-${bbox.join("_")}.json`);
let data: MapData;
try {
  data = JSON.parse(await readFile(cacheFile, "utf8"));
  console.log("Données en cache :", cacheFile);
} catch {
  const started = Date.now();
  data = await collectMapData(bbox, AbortSignal.timeout(70000));
  await writeFile(cacheFile, JSON.stringify(data));
  console.log(
    `Collecte : ${((Date.now() - started) / 1000).toFixed(1)} s · ${data.elements.length} éléments`,
  );
}
for (const line of [...data.sources, ...data.warnings]) console.log(" ·", line);

const settings: ModelSettings = {
  ...DEFAULT_SETTINGS,
  cols: Number(option("cols") ?? 1),
  rows: Number(option("rows") ?? 1),
  bedWidthMm: Number(option("bed") ?? DEFAULT_SETTINGS.bedWidthMm),
  bedDepthMm: Number(option("bed") ?? DEFAULT_SETTINGS.bedDepthMm),
  relief: flag("relief"),
  roofs: !flag("no-roofs"),
  ...(option("size")
    ? { sizeMode: "custom" as const, longSideMm: Number(option("size")) }
    : {}),
};
const started = Date.now();
const model = await buildModel({ data, settings }, (_, label) => {
  if (flag("verbose"))
    console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s  ${label}`);
});
const { layout, stats } = model;
console.log(
  `Construction : ${((Date.now() - started) / 1000).toFixed(1)} s · ${layout.widthMm.toFixed(1)} × ${layout.depthMm.toFixed(1)} × ${model.heightMm.toFixed(1)} mm · 1:${Math.round(layout.scale)}`,
);
console.log(
  `${layout.cols} × ${layout.rows} plaques de ${layout.tileWidthMm.toFixed(1)} × ${layout.tileDepthMm.toFixed(1)} mm · ${stats.buildings} bâtiments (${stats.roofs} toits en pente, ${stats.estimatedHeights} hauteurs estimées) · ${stats.triangles} triangles · ${stats.volumeCm3.toFixed(1)} cm³`,
);
for (const warning of model.warnings) console.log(" !", warning);
let defects = 0;
for (const tile of model.tiles)
  for (const [name, mesh] of [
    ["solide", tile.solid] as const,
    ...tile.parts.map((part) => [part.layer, part] as const),
  ]) {
    const defect = meshDefect(mesh);
    if (defect) {
      defects++;
      console.log(` ✗ plaque ${tile.label} · ${name} : ${defect}`);
    }
  }
console.log(
  defects
    ? `${defects} maillage(s) défectueux`
    : `✓ ${model.tiles.length} plaque(s) : solides fermés et orientés`,
);
for (const format of ["stl", "3mf"] as ExportFormat[]) {
  const file = await exportModel(model, settings, format, "maquette");
  await writeFile(join(out, file.filename), file.bytes);
  console.log(
    "→",
    join(out, file.filename),
    `${(file.bytes.length / 1e6).toFixed(1)} Mo`,
  );
}
