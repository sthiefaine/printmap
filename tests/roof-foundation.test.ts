import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-north-roof.json", import.meta.url),
    "utf8",
  ),
) as Omit<PrintInput, "settings">;

function roofAt(mesh: PrintMesh, x: number, y: number) {
  const heights: number[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-10) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= 0 && v >= 0 && u + v <= 1)
      heights.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return heights;
}

test("the real northern roof keeps its low surveyed panel connected at the selection boundary", async () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel({ ...fixture, settings });
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.measuredStructureCount, 0);
  assert.equal(model.stats.components, 1);
  assert.equal(model.stats.discardedFeatures, 0);
  const expectedLowRoof =
    3 + ((30.3 - fixture.elevationGrid!.minElev) * 1000) / fixture.scale;
  const lowRoof = roofAt(model, -85.5, 91.5);
  assert.ok(
    lowRoof.some((z) => Math.abs(z - expectedLowRoof) < 0.0001),
    `the clipped source panel stays at elevation 30.3 m: ${lowRoof.join(", ")}`,
  );
  assert.equal(
    Math.min(...model.positions.filter((_, i) => i % 3 === 2)),
    0,
    "the common socle keeps its original flat underside",
  );
  assert.ok(
    !model.warnings.some((message) =>
      /toiture.*repli|fragment.*détaché/i.test(message),
    ),
  );
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
});

test("clipped surveyed roof wings keep both heights when numeric overlap would close their source gap", async () => {
  const clippedFixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-clipped-roof-wings.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Omit<PrintInput, "settings">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel({ ...clippedFixture, settings });
  assert.equal(model.stats.buildingCount, 2);
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.measuredStructureCount, 0);
  assert.equal(model.stats.components, 1);
  assert.equal(model.stats.discardedFeatures, 0);
  // B140305's two narrow wings meet the north selection edge at different
  // surveyed elevations. The neighbouring B140304 is retained as context.
  for (const [x, y, elevation] of [
    [-85.1, 36.3, 49.398],
    [-85.08, 36.3, 45.574],
  ]) {
    const expected =
      3 +
      ((elevation - clippedFixture.elevationGrid!.minElev) * 1000) /
        clippedFixture.scale;
    assert.ok(
      roofAt(model, x, y).some((z) => Math.abs(z - expected) < 0.0001),
      `the source wing stays at elevation ${elevation} m`,
    );
  }
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
});
