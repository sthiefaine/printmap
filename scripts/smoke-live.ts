import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createSTLBuffer } from "../src/lib/export/stl-export";
import { create3MFBuffer } from "../src/lib/export/threemf-export";
import {
  DEFAULT_MODEL_SETTINGS,
  useSceneStore,
} from "../src/store/use-scene-store";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";
import type { BBox, MapDataResponse } from "../src/types/osm";
import { assertClosedSolid } from "../tests/helpers/solid";

// Optional live smoke test: npm run smoke:live -- --api http://localhost:3000
// --coast exercises actual marine polygons; --input reuses a collected response.
// --bbox south,west,north,east must match that response when reusing another zone.
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const coast = args.includes("--coast");
const name = args.includes("--name")
  ? option("--name").replace(/[^a-z0-9_-]/gi, "-")
  : coast
    ? "palavas"
    : "montpellier";
const placeName = args.includes("--label")
  ? option("--label")
  : args.includes("--name")
    ? name
    : coast
      ? "Palavas-les-Flots"
      : "Montpellier";
const bbox: BBox = args.includes("--bbox")
  ? (option("--bbox").split(",").map(Number) as BBox)
  : coast
    ? [43.517, 3.93, 43.528, 3.945]
    : [43.608, 3.872, 43.616, 3.884];
assert.ok(
  bbox.length === 4 && bbox.every(Number.isFinite),
  "bbox must contain four finite coordinates",
);
let data: MapDataResponse;
if (args.includes("--input"))
  data = JSON.parse(await readFile(option("--input"), "utf8"));
else {
  const url = args.includes("--api")
    ? option("--api")
    : "http://localhost:3000";
  const response = await fetch(new URL("/api/map-data", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox, relief: !coast }),
    signal: AbortSignal.timeout(100_000),
  });
  if (!response.ok)
    throw new Error(
      `collect returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  data = await response.json();
}
assert.ok(data.osmData.elements.length > 0, "real data is available");
const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
if (args.includes("--detail")) {
  settings.features.roads.filter = "all";
  settings.features.roads.footpathsEnabled = true;
}
// Keep the coloured model and monochrome engraving as separate real recipes.
if (args.includes("--engrave")) {
  settings.features.roads.heightMm = -0.2;
  settings.features.parks.heightMm = -0.1;
  settings.features.water.heightMm = -0.2;
}
settings.base.topographyEnabled = !coast;
settings.base.grid = { cols: 2, rows: 2 };
const geographic = getBboxDimensions(bbox, 1000);
const size = args.includes("--size") ? Number(option("--size")) : 200;
assert.ok(Number.isFinite(size) && size >= 20 && size <= 1000);
const scale = (Math.max(geographic.widthMm, geographic.heightMm) * 1000) / size;
const start = performance.now();
const model = await buildPrintModel(
  { ...data, bbox, scale, settings },
  (progress, label) => console.log(`${progress}% ${label}`),
);
const volume = assertClosedSolid(model);
const tileVolume = model.tiles
  .map(assertClosedSolid)
  .reduce((a, b) => a + b, 0);
assert.ok(
  Math.abs(tileVolume - volume) / volume < 1e-4,
  "tile volumes conserve the printed solid",
);
assert.equal(model.stats.components, 1);
const directory = resolve("artifacts", name);
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, `${name}.stl`),
  Buffer.from(createSTLBuffer(model)),
);
await writeFile(
  resolve(directory, `${name}.3mf`),
  Buffer.from(await create3MFBuffer(model, model.colors)),
);
for (const tile of model.tiles) {
  const stem = `${name}-tuile-${tile.row + 1}-${tile.col + 1}`;
  await writeFile(
    resolve(directory, `${stem}.stl`),
    Buffer.from(createSTLBuffer(tile)),
  );
  await writeFile(
    resolve(directory, `${stem}.3mf`),
    Buffer.from(await create3MFBuffer(tile, model.colors, model)),
  );
}
await writeFile(
  resolve(directory, "SOURCES.txt"),
  `${model.sources.join("\n")}\nCollecte : ${model.fetchedAt}\nTuiles : lignes du sud au nord, colonnes de l’ouest à l’est. Unités : millimètres.\n${model.warnings.join("\n")}\n`,
);
useSceneStore.setState({ scale, tileSize: size, modelSettings: settings });
await writeFile(
  resolve(directory, `${name}.printmap.json`),
  useSceneStore.getState().saveProject({
    ...data,
    bbox,
    selectedCity: {
      name: placeName,
      lat: (bbox[0] + bbox[2]) / 2,
      lng: (bbox[1] + bbox[3]) / 2,
    },
    isDemo: false,
  }),
);
await writeFile(
  resolve(directory, "verification.json"),
  JSON.stringify(
    {
      fetchedAt: data.report.fetchedAt,
      report: data.report,
      dimensions: model.dimensions,
      stats: model.stats,
      warnings: model.warnings,
      buildSeconds: (performance.now() - start) / 1000,
      verification:
        "Full model and all four tiles have closed, consistently oriented boundaries and positive volume.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      directory,
      seconds: (performance.now() - start) / 1000,
      dimensions: model.dimensions,
      stats: model.stats,
      report: data.report,
      warnings: model.warnings,
    },
    null,
    2,
  ),
);
