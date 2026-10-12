import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SAINT_ETIENNE_STADIUM_BBOX,
  salonPrintLayouts,
  salonLayoutSettings,
  salonLayoutDimensions,
} from "../src/lib/print-layout";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";
import type { BBox } from "../src/types/osm";
import type { OverpassElement } from "../src/types/osm";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { assertClosedSolid } from "./helpers/solid";

test("Saint-Étienne salon layouts preserve geography and fit 150 mm beds with 5 mm margin", () => {
  const bbox = [...SAINT_ETIENNE_STADIUM_BBOX] as BBox;
  const layouts = salonPrintLayouts(bbox);
  assert.deepEqual(
    layouts.map((layout) => layout.count),
    [2, 4, 6, 9],
  );
  assert.deepEqual(
    layouts.map((layout) => layout.grid),
    [
      { cols: 1, rows: 2 },
      { cols: 2, rows: 2 },
      { cols: 2, rows: 3 },
      { cols: 3, rows: 3 },
    ],
  );
  for (const layout of layouts) {
    assert.ok(layout.tileWidthMm <= 145 + 1e-10);
    assert.ok(layout.tileHeightMm <= 145 + 1e-10);
    const realDimensions = getBboxDimensions(bbox, layout.scale);
    assert.ok(Math.abs(realDimensions.widthMm - layout.widthMm) < 1e-10);
    assert.ok(Math.abs(realDimensions.heightMm - layout.heightMm) < 1e-10);
    assert.equal(layout.grid.cols * layout.grid.rows, layout.count);
    assert.ok(
      Math.abs(layout.tileWidthMm * layout.grid.cols - layout.widthMm) < 1e-10,
    );
    assert.ok(
      Math.abs(layout.tileHeightMm * layout.grid.rows - layout.heightMm) <
        1e-10,
    );
  }
  const [two, four, six, nine] = layouts;
  assert.ok(Math.abs(two.widthMm - 145) < 1e-10);
  assert.ok(Math.abs(two.heightMm - 196.28378547805725) < 1e-9);
  assert.ok(Math.abs(two.tileHeightMm - 98.14189273902863) < 1e-9);
  assert.ok(Math.abs(two.scale - 19261.02809107234) < 1e-8);
  assert.ok(Math.abs(four.longSideMm - 290) < 1e-10);
  assert.ok(Math.abs(six.widthMm - 290) < 1e-10);
  assert.ok(Math.abs(six.longSideMm - 392.5675709561145) < 1e-9);
  assert.ok(Math.abs(nine.longSideMm - 435) < 1e-10);
  assert.ok(four.longSideMm / two.longSideMm > 1.47);
  assert.ok(six.longSideMm / four.longSideMm > 1.35);
  assert.equal(nine.longSideMm / four.longSideMm, 1.5);
  assert.match(
    salonLayoutDimensions(two),
    /2 plaques : taille réelle assemblée 145 × 196,3 mm ; chaque plaque 145 × 98,1 mm/,
  );
  assert.match(
    salonLayoutDimensions(four),
    /4 plaques : taille réelle assemblée 214,2 × 290 mm ; chaque plaque 107,1 × 145 mm/,
  );
  assert.deepEqual(bbox, SAINT_ETIENNE_STADIUM_BBOX);
});

test("selecting a salon layout restores equal physical scales without changing printing thresholds or colours", () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.elevationExaggeration = 2;
  settings.base.topographyEnabled = false;
  settings.features.buildings.buildingScale = 1.7;
  settings.features.buildings.roofs = false;
  settings.features.buildings.color = "#b36644";
  settings.features.roads.heightMm = -0.2;
  const before = structuredClone(settings);
  const layout = salonPrintLayouts(SAINT_ETIENNE_STADIUM_BBOX).find(
    (option) => option.count === 6,
  )!;
  const updated = salonLayoutSettings(settings, layout);
  assert.equal(updated.base.elevationExaggeration, 1);
  assert.equal(updated.base.topographyEnabled, true);
  assert.equal(updated.features.buildings.buildingScale, 1);
  assert.equal(updated.features.buildings.roofs, true);
  assert.deepEqual(updated.base.grid, { cols: 2, rows: 3 });
  assert.deepEqual(updated.print, before.print);
  assert.equal(
    updated.features.buildings.color,
    before.features.buildings.color,
  );
  assert.deepEqual(updated.features.roads, before.features.roads);
  assert.deepEqual(settings, before);
});

test("layout bounds also hold for a wide selection and reject a collapsed rectangle", () => {
  const wide: BBox = [45.43, 4.37, 45.435, 4.41];
  const layouts = salonPrintLayouts(wide);
  assert.deepEqual(layouts[0].grid, { cols: 2, rows: 1 });
  const geographic = getBboxDimensions(wide, 1000);
  const wrongOrientationFactor = Math.min(
    145 / geographic.widthMm,
    290 / geographic.heightMm,
  );
  assert.ok(layouts[0].scale < 1000 / wrongOrientationFactor);
  for (const layout of layouts) {
    assert.ok(layout.tileWidthMm <= 145 + 1e-10);
    assert.ok(layout.tileHeightMm <= 145 + 1e-10);
  }
  assert.throws(
    () => salonPrintLayouts([45.43, 4.37, 45.43, 4.41]),
    /invalide/,
  );
});

test("the actual observatory tower fits the six- and nine-plate formats at its stated height without reducing printable width", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/saint-etienne-tour-observatoire.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { element: OverpassElement; source: string; license: string };
  assert.match(fixture.source, /172156092/);
  assert.match(fixture.license, /OpenStreetMap contributors.*ODbL/);
  assert.equal(fixture.element.tags?.height, "31");
  for (const layout of salonPrintLayouts(SAINT_ETIENNE_STADIUM_BBOX)) {
    const settings = salonLayoutSettings(
      structuredClone(DEFAULT_MODEL_SETTINGS),
      layout,
    );
    // Isolate physical print scale from terrain: the real mapped footprint and
    // stated OSM height are unchanged, and the standard 0.8 mm width guard stays.
    settings.base.topographyEnabled = false;
    const model = await buildPrintModel({
      osmData: { elements: [fixture.element] },
      elevationGrid: null,
      bbox: SAINT_ETIENNE_STADIUM_BBOX,
      scale: layout.scale,
      settings,
    });
    assert.equal(model.stats.buildingCount, layout.count <= 4 ? 0 : 1);
    const volume = assertClosedSolid(model);
    const tilesVolume = model.tiles
      .map(assertClosedSolid)
      .reduce((a, b) => a + b, 0);
    assert.equal(model.tiles.length, layout.count);
    assert.ok(Math.abs(tilesVolume - volume) / volume < 1e-4);
    if (layout.count > 4) {
      const top = Array.from(model.positions)
        .filter((_, index) => index % 3 === 2)
        .reduce((maximum, z) => Math.max(maximum, z), -Infinity);
      assert.ok(
        Math.abs(
          top -
            (settings.base.basePlateThicknessMm + (31 * 1000) / layout.scale),
        ) < 0.0001,
      );
    }
  }
});
