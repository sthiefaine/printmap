import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { assertClosedSolid } from "./helpers/solid";
import { PRINT_LAYERS, type PrintInput } from "../src/types/print";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-sainte-anne-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid"> & {
  fullChurchBbox: PrintInput["bbox"];
};

for (const label of ["Peyrou crop", "whole church"] as const) {
  test(`Sainte-Anne retains its measured nave and narrow spire in the ${label}`, async () => {
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    settings.base.grid = { cols: 2, rows: 2 };
    const model = await buildPrintModel({
      ...fixture,
      bbox: label === "Peyrou crop" ? fixture.bbox : fixture.fullChurchBbox,
      settings,
    });
    assert.equal(
      model.stats.realRoofCount,
      1,
      "the surveyed church must not become a maximum-height extrusion",
    );
    assert.equal(model.stats.buildingCount, 1);
    assert.equal(model.stats.discardedFeatures, 0);
    assert.ok(
      !model.warnings.some((warning) => /toiture.*repli/i.test(warning)),
    );
    const volume = assertClosedSolid(model);
    assert.equal(model.tiles.length, 4);
    const tileVolume = model.tiles.reduce(
      (sum, tile) => sum + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
    const buildingLayer = PRINT_LAYERS.indexOf("buildings");
    const vertices = new Set<number>();
    for (let face = 0; face < model.faceLayers.length; face++)
      if (model.faceLayers[face] === buildingLayer)
        for (const vertex of model.indices.subarray(face * 3, face * 3 + 3))
          vertices.add(vertex);
    const points = [...vertices].map((index) =>
      Array.from(model.positions.subarray(index * 3, index * 3 + 3)),
    );
    const maxZ = Math.max(...points.map((point) => point[2]));
    const high = points.filter((point) => point[2] > maxZ - 8);
    const xRange = (values: number[][]) =>
      Math.max(...values.map((p) => p[0])) -
      Math.min(...values.map((p) => p[0]));
    const yRange = (values: number[][]) =>
      Math.max(...values.map((p) => p[1])) -
      Math.min(...values.map((p) => p[1]));
    assert.ok(
      xRange(high) < xRange(points) * 0.5 &&
        yRange(high) < yRange(points) * 0.5,
      "only the bell tower reaches the upper eight millimetres, not the nave footprint",
    );
    const groundZ =
      settings.base.basePlateThicknessMm +
      (44.63 - fixture.elevationGrid!.minElev) * (1000 / fixture.scale);
    assert.ok(
      Math.abs(maxZ - (groundZ + 67.341 * (1000 / fixture.scale))) < 0.03,
      "the IGN69 source roof altitude uses the same terrain datum",
    );
  });
}
