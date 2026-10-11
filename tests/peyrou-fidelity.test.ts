import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { PRINT_LAYERS, type PrintInput } from "../src/types/print";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

test("the real Chateau keeps its absolute survey datum and the mapped treads replace its inclined source floors", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-peyrou-chateau-stairs.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { bbox: BBox; elements: OverpassElement[]; terrainGrid: ElevationGrid };
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.features.roads.filter = "all";
  settings.features.roads.footpathsEnabled = true;
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const input: PrintInput = {
    bbox: fixture.bbox,
    scale: 1824.8671371451785,
    osmData: { elements: fixture.elements },
    elevationGrid: fixture.terrainGrid,
    settings,
  };
  const model = await buildPrintModel(input);
  assert.equal(model.stats.measuredStructureCount, 1);
  assert.equal(model.stats.staircaseCount, 2);
  assert.ok(
    model.warnings.some((message) =>
      /2 escalier.*surfaces de circulation mesurées/.test(message),
    ),
  );
  const sf = 1000 / input.scale;
  const sourceMax = Math.max(
    ...fixture.elements[0].measuredSolid!.surfaces.flatMap((surface) =>
      surface.outer.map((point) => point.elevation),
    ),
  );
  const expectedMax = 3 + (sourceMax - fixture.terrainGrid.minElev) * sf;
  assert.ok(
    Math.abs(model.dimensions.heightMm - expectedMax) < 0.002,
    "the shell must not be lifted to the maximum DEM elevation",
  );
  let upwardTreads = 0;
  for (let at = 0; at < model.indices.length; at += 3) {
    if (PRINT_LAYERS[model.faceLayers[at / 3]] !== "roads") continue;
    const [a, b, c] = Array.from(model.indices.slice(at, at + 3), (i) =>
      Array.from(model.positions.slice(i * 3, i * 3 + 3)),
    );
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (nz <= 1e-8 || nz / Math.hypot(nx, ny, nz) < 0.95) continue;
    upwardTreads++;
    assert.ok(
      Math.max(a[2], b[2], c[2]) - Math.min(a[2], b[2], c[2]) < 0.0001,
      "printed stair tops are horizontal rather than source ramps",
    );
  }
  assert.ok(upwardTreads >= 8);
  const volume = assertClosedSolid(model);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
});
