import test from "node:test";
import assert from "node:assert/strict";
import {
  fitPlateCount,
  splitAtCurrentScale,
  usablePlateSize,
} from "../src/lib/plate-layout";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeSettings,
} from "../src/store/use-scene-store";
import { DEMO_BBOX, createDemoData } from "../src/lib/demo";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import {
  validateExportLayout,
  assemblyPlanSVG,
} from "../src/lib/export/validate-layout";
import { assertClosedSolid } from "./helpers/solid";
import type { BBox } from "../src/types/osm";

test("every count from one to 25 fits 10 and 15 cm plates without distorting portrait or landscape geography", () => {
  for (const bbox of [
    [45.4288, 4.3702, 45.4628, 4.406],
    [43.6, 3.87, 43.605, 3.9],
  ] as BBox[])
    for (const plate of [100, 150] as const)
      for (let count = 1; count <= 25; count++) {
        const layout = fitPlateCount(bbox, count, plate);
        const reference = fitPlateCount(bbox, 1, plate);
        assert.equal(layout.grid.cols * layout.grid.rows, count);
        assert.ok(layout.tileWidthMm <= usablePlateSize(plate) + 1e-8);
        assert.ok(layout.tileDepthMm <= usablePlateSize(plate) + 1e-8);
        assert.ok(layout.longSideMm <= 1000 + 1e-8);
        assert.ok(
          Math.abs(
            layout.widthMm / layout.depthMm -
              reference.widthMm / reference.depthMm,
          ) < 1e-12,
        );
      }
  assert.throws(() => fitPlateCount(DEMO_BBOX, 26, 100), /25/);
  assert.throws(() => fitPlateCount(DEMO_BBOX, 2.5, 150), /25/);
});

test("cutting the current size keeps its source scale and finds enough 95 mm pieces", () => {
  const original = fitPlateCount(DEMO_BBOX, 4, 150);
  const split = splitAtCurrentScale(DEMO_BBOX, original.scale, 100);
  assert.equal(split.scale, original.scale);
  assert.ok(Math.abs(split.widthMm - original.widthMm) < 1e-8);
  assert.ok(Math.abs(split.depthMm - original.depthMm) < 1e-8);
  assert.ok(split.count > original.count);
  assert.ok(split.tileWidthMm <= 95 + 1e-8 && split.tileDepthMm <= 95 + 1e-8);
  assert.throws(() => splitAtCurrentScale(DEMO_BBOX, 1, 100), /25 plaques/);
});

test("saved layouts retain plate size and prime-count grids, reject oversized imports, and accept legacy projects", () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = { cols: 1, rows: 7 };
  settings.base.plateSizeMm = 100;
  const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(restored.base.grid, { cols: 1, rows: 7 });
  assert.equal(restored.base.plateSizeMm, 100);
  assert.deepEqual(restored.print, settings.print);
  assert.ok(normalizeSettings(DEFAULT_MODEL_SETTINGS));
  assert.throws(
    () =>
      normalizeSettings({
        ...settings,
        base: { ...settings.base, grid: { cols: 5, rows: 6 } },
      }),
    /grille/,
  );
  assert.throws(
    () =>
      normalizeSettings({
        ...settings,
        base: { ...settings.base, plateSizeMm: 250 },
      }),
    /format/,
  );
});

test("a seven-piece real CAD cut closes every tile, conserves volume and enforces the selected bed at export", async () => {
  const layout = fitPlateCount(DEMO_BBOX, 7, 100);
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = layout.grid;
  settings.base.plateSizeMm = 100;
  const model = await buildPrintModel({
    ...createDemoData(),
    bbox: DEMO_BBOX,
    scale: layout.scale,
    settings,
  });
  assert.equal(model.tiles.length, 7);
  const volume = assertClosedSolid(model);
  const cutVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(cutVolume - volume) / volume < 1e-4);
  validateExportLayout(model, layout.grid);
  assert.match(assemblyPlanSVG(model), /NORD/);
  assert.match(assemblyPlanSVG(model), /7–1|1–7/);
  assert.throws(
    () =>
      validateExportLayout(
        {
          ...model,
          tiles: [],
          dimensions: { ...model.dimensions, widthMm: 100 },
        },
        { cols: 1, rows: 1 },
      ),
    /95 × 95/,
  );
});
