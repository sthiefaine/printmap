import test from "node:test";
import assert from "node:assert/strict";
import {
  useSceneStore,
  DEFAULT_MODEL_SETTINGS,
  normalizeSettings,
} from "../src/store/use-scene-store";
import { createDemoData, DEMO_BBOX } from "../src/lib/demo";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";
import { validateImportedElements } from "../src/lib/data/validate-imported-elements";

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

test("existing projects enable the optional balcony interpretation and preserve an explicit opt-out", () => {
  const old = structuredClone(DEFAULT_MODEL_SETTINGS);
  delete old.features.buildings.balconies;
  assert.equal(normalizeSettings(old).features.buildings.balconies, true);
  old.features.buildings.balconies = false;
  assert.equal(normalizeSettings(old).features.buildings.balconies, false);
  (old.features.buildings as unknown as Record<string, unknown>).balconies =
    "yes";
  assert.throws(() => normalizeSettings(old), /Options du projet invalides/);
});

test("old settings retain optional documented facade relief and respect an explicit opt-out", () => {
  const old = structuredClone(DEFAULT_MODEL_SETTINGS);
  delete old.features.buildings.documentedFacades;
  assert.equal(
    normalizeSettings(old).features.buildings.documentedFacades,
    true,
  );
  old.features.buildings.documentedFacades = false;
  assert.equal(
    normalizeSettings(old).features.buildings.documentedFacades,
    false,
  );
  (
    old.features.buildings as unknown as Record<string, unknown>
  ).documentedFacades = "yes";
  assert.throws(() => normalizeSettings(old), /Options du projet invalides/);
});

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

test("malformed road filters are rejected before changing the current project", () => {
  for (const roadTypeEnabled of [null, [], { residential: "yes" }]) {
    const saved = project();
    saved.settings.features.roads.roadTypeEnabled = roadTypeEnabled;
    const current = useSceneStore.getState();
    assert.throws(
      () => useSceneStore.getState().loadProject(JSON.stringify(saved)),
      /Options des voies du projet invalides/,
    );
    assert.equal(useSceneStore.getState(), current);
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

test("an old project with stale relief from another zone is rejected before changing current settings", () => {
  const saved = project();
  // Both individual bounds are valid. The geographic association is stale,
  // as can happen when an older project retained its previous elevation cache.
  saved.snapshot.bbox = DEMO_BBOX.map((coordinate) => coordinate + 0.01);
  saved.settings.features.water.color = "#123abc";
  const current = useSceneStore.getState().modelSettings;
  assert.throws(
    () => useSceneStore.getState().loadProject(JSON.stringify(saved)),
    /Le relief du projet ne correspond pas à la zone enregistrée/,
  );
  assert.equal(useSceneStore.getState().modelSettings, current);
  useSceneStore.getState().resetSettings();
});

test("malformed ordinary coordinates and tags reject an import atomically before meshing", () => {
  const invalidElements = [
    {
      type: "way",
      id: 1,
      tags: { highway: "residential" },
      geometry: [{ lat: "oops", lon: 3.87 }],
    },
    { type: "way", id: 1, geometry: [{ lat: 86, lon: 3.87 }] },
    { type: "node", id: 1, lat: 43.61, lon: 181 },
    { type: "node", id: 1, lat: 43.61 },
    { type: "way", id: 1, tags: { highway: 42 } },
    {
      type: "relation",
      id: 1,
      members: [
        { type: "way", role: "outer", geometry: [{ lat: 43.61, lon: "oops" }] },
      ],
    },
    {
      type: "relation",
      id: 1,
      members: [{ type: "way", role: "outer", geometry: "invalid" }],
    },
    null,
  ];
  for (const element of invalidElements) {
    const saved = project();
    saved.snapshot.osmData.elements = [element];
    saved.settings.features.water.color = "#123abc";
    saved.scale = 1234;
    const current = useSceneStore.getState();
    assert.throws(
      () => useSceneStore.getState().loadProject(JSON.stringify(saved)),
      /projet invalide/,
    );
    assert.equal(useSceneStore.getState(), current);
  }
  useSceneStore.getState().resetSettings();
});

test("normal Overpass elements and relation references without geometry remain importable", () => {
  const saved = project();
  saved.snapshot.osmData.elements = [
    { type: "node", id: 1 },
    {
      type: "node",
      id: 2,
      lat: 43.61,
      lon: 3.87,
      tags: { name: "Reference node" },
    },
    { type: "way", id: 3, nodes: [1, 2], tags: { highway: "residential" } },
    {
      type: "relation",
      id: 4,
      members: [{ type: "way", ref: 3, role: "outer" }],
      tags: { type: "multipolygon", leisure: "park" },
    },
  ];
  const snapshot = useSceneStore.getState().loadProject(JSON.stringify(saved));
  assert.deepEqual(
    snapshot?.osmData?.elements,
    saved.snapshot.osmData.elements,
  );
  useSceneStore.getState().resetSettings();
});

test("import coordinate budget includes ordinary ways and relation member geometry", () => {
  const point = { lat: 43.61, lon: 3.87 };
  assert.throws(
    () =>
      validateImportedElements([
        { type: "way", id: 1, geometry: Array(600_000).fill(point) },
        {
          type: "relation",
          id: 2,
          members: [
            {
              type: "way",
              role: "outer",
              geometry: Array(400_001).fill(point),
            },
          ],
        },
      ]),
    /trop de coordonnées géographiques/,
  );
});
