import test from "node:test";
import assert from "node:assert/strict";
import {
  useSceneStore,
  DEFAULT_MODEL_SETTINGS,
} from "../src/store/use-scene-store";
import { createDemoData, DEMO_BBOX } from "../src/lib/demo";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";

function project() {
  useSceneStore.getState().resetSettings();
  useSceneStore.getState().fitSelection(DEMO_BBOX);
  return JSON.parse(
    useSceneStore.getState().saveProject({
      ...createDemoData(),
      bbox: DEMO_BBOX,
      selectedCity: { name: "Démo", lat: 43.609, lng: 3.87 },
      isDemo: true,
    }),
  );
}

test("project round trip keeps raw geography and custom printing settings", () => {
  const saved = project();
  saved.settings.features.water.color = "#123abc";
  saved.settings.print.minFeatureMm = 0.6;
  const snapshot = useSceneStore.getState().loadProject(JSON.stringify(saved));
  assert.deepEqual(snapshot?.bbox, DEMO_BBOX);
  assert.deepEqual(snapshot?.osmData, saved.snapshot.osmData);
  assert.deepEqual(snapshot?.elevationGrid, saved.snapshot.elevationGrid);
  assert.equal(
    useSceneStore.getState().modelSettings.features.water.color,
    "#123abc",
  );
  assert.equal(useSceneStore.getState().modelSettings.print.minFeatureMm, 0.6);
});

test("legacy settings migrate without the unsupported visual-only options", () => {
  const saved = project();
  saved.version = 1;
  delete saved.snapshot;
  delete saved.settings.print;
  saved.settings.features.buildings.windows = true;
  saved.settings.features.water.waterCutout = true;
  assert.equal(
    useSceneStore.getState().loadProject(JSON.stringify(saved)),
    null,
  );
  assert.equal(
    useSceneStore.getState().modelSettings.features.buildings.windows,
    false,
  );
  assert.equal(
    useSceneStore.getState().modelSettings.features.water.waterCutout,
    false,
  );
  assert.equal(useSceneStore.getState().modelSettings.print.minFeatureMm, 0.8);
});

test("imports reject geometry-breaking sizes, invalid bounds and corrupted relief", () => {
  const invalidChanges: ((saved: ReturnType<typeof project>) => void)[] = [
    (saved) => {
      saved.settings.base.grid.cols = 1.5;
    },
    (saved) => {
      saved.settings.features.buildings.buildingScale = -1;
    },
    (saved) => {
      saved.settings.base.baseColor = "invalid";
    },
    (saved) => {
      saved.snapshot.bbox = [90, 3, 91, 4];
    },
    (saved) => {
      saved.snapshot.elevationGrid.points[0] = null;
    },
    (saved) => {
      saved.snapshot.elevationGrid.cols = 2.5;
    },
  ];
  for (const mutate of invalidChanges) {
    const saved = project();
    mutate(saved);
    assert.throws(() =>
      useSceneStore.getState().loadProject(JSON.stringify(saved)),
    );
  }
});

test("sizing selection preserves geographic aspect ratio and fits the requested length", () => {
  useSceneStore.getState().setTileSize(180, DEMO_BBOX);
  const mm = getBboxDimensions(DEMO_BBOX, useSceneStore.getState().scale);
  assert.ok(Math.abs(Math.max(mm.widthMm, mm.heightMm) - 180) < 1e-8);
  const original = getBboxDimensions(DEMO_BBOX, 1000);
  assert.ok(
    Math.abs(mm.widthMm / mm.heightMm - original.widthMm / original.heightMm) <
      1e-8,
  );
  useSceneStore.getState().resetSettings();
  assert.deepEqual(
    useSceneStore.getState().modelSettings,
    DEFAULT_MODEL_SETTINGS,
  );
});
