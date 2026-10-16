import assert from "node:assert/strict";
import test from "node:test";
import earcut from "earcut";
import source from "./fixtures/montpellier-hotel-region-roofs.json";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import {
  DEFAULT_MODEL_SETTINGS,
  PRINT_PROFILES,
} from "../src/store/use-scene-store";
import type { OverpassElement } from "../src/types/osm";
import type { PrintInput, PrintMesh } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const bbox: PrintInput["bbox"] = [
  43.601407977642914, 3.893206659524327, 43.607928059285825, 3.9022093950324357,
];
const originLat = 43.594887896;
const sf = 0.2;
const projection = createProjectionForBbox(bbox, originLat);
const snapshot = JSON.stringify(source);

function input(enabled?: boolean): PrintInput {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.print = { ...PRINT_PROFILES.detail.print };
  settings.base.grid = { cols: 2, rows: 2 };
  if (enabled === undefined)
    delete settings.features.buildings.documentedFacades;
  else settings.features.buildings.documentedFacades = enabled;
  for (const layer of ["roads", "water", "parks", "sand", "piers"] as const)
    settings.features[layer].enabled = false;
  return {
    bbox,
    scale: 5000,
    settings,
    assemblyFrame: { originLat, elevationDatumM: 0 },
    osmData: { elements: [structuredClone(source) as OverpassElement] },
    // Explicit synthetic IGN69 zero control: all source roofs stay unchanged.
    elevationGrid: {
      rows: 2,
      cols: 2,
      points: [0, 0, 0, 0],
      minElev: 0,
      maxElev: 0,
      south: bbox[0],
      west: bbox[1],
      north: bbox[2],
      east: bbox[3],
      source: "Declared synthetic zero-elevation IGN69 print control",
    },
  };
}

function topAt(mesh: PrintMesh, x: number, y: number) {
  let top = -Infinity;
  const p = mesh.positions;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const a = mesh.indices[at] * 3,
      b = mesh.indices[at + 1] * 3,
      c = mesh.indices[at + 2] * 3;
    const det =
      (p[b] - p[a]) * (p[c + 1] - p[a + 1]) -
      (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (Math.abs(det) < 1e-12) continue;
    const u =
      ((x - p[a]) * (p[c + 1] - p[a + 1]) - (y - p[a + 1]) * (p[c] - p[a])) /
      det;
    const v =
      ((p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a])) /
      det;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
    top = Math.max(
      top,
      p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]),
    );
  }
  return top;
}

test("documented facade relief reaches the assembly builder, keeps its four native roofs and can be disabled", async () => {
  const preparedInput = input();
  const saved = JSON.stringify(preparedInput);
  const model = await buildPrintModel(preparedInput);
  const plain = await buildPrintModel(input(false));
  assert.equal(model.stats.documentedFacadeBuildingCount, 1);
  assert.equal(plain.stats.documentedFacadeBuildingCount, 0);
  assert.equal(
    model.stats.realRoofCount,
    1,
    "the measured roof remains separately identified",
  );
  assert.equal(model.landmarks?.[0].representation, "documented-facade");
  assert.equal(plain.landmarks?.[0].representation, "surveyed-roof");
  assert.ok(model.sources.some((s) => s.includes("Ganibenc")));
  assert.ok(model.warnings.some((s) => s.includes("profondeur estimées")));
  assert.ok(!plain.sources.some((s) => s.includes("Ganibenc")));
  const volume = assertClosedSolid(model),
    plainVolume = assertClosedSolid(plain);
  // Two 1.6 × 4.2 mm reliefs, 0.30 mm deep. The source envelope has the
  // builder's existing five-micron overlap, within the declared 0.02 mm³ check.
  assert.ok(Math.abs(plainVolume - volume - 2 * 1.6 * 4.2 * 0.3) < 0.02);
  assert.ok(Math.abs(model.dimensions.widthMm - 145) < 0.0001);
  assert.ok(Math.abs(model.dimensions.depthMm - 145) < 0.0001);
  assert.equal(model.tiles.length, 4);
  const cutVolume = model.tiles.reduce(
    (total, tile) => total + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(cutVolume - volume) / volume < 0.0001);
  let probes = 0;
  for (const roof of source.roofSurfaces) {
    const xy: number[] = [],
      holes: number[] = [];
    for (const [index, ring] of [roof.outer, ...roof.holes].entries()) {
      if (index) holes.push(xy.length / 2);
      for (const point of ring)
        xy.push(...projection.project(point.lon, point.lat).map((v) => v * sf));
    }
    const triangles = earcut(xy, holes);
    for (let i = 0; i < triangles.length; i += 3) {
      const points = triangles.slice(i, i + 3);
      const x = points.reduce((sum, at) => sum + xy[at * 2], 0) / 3;
      const y = points.reduce((sum, at) => sum + xy[at * 2 + 1], 0) / 3;
      const expected = 3 + roof.outer[0].elevation * sf;
      assert.ok(Math.abs(topAt(model, x, y) - expected) < 0.00001);
      assert.ok(Math.abs(topAt(plain, x, y) - expected) < 0.00001);
      probes++;
    }
  }
  assert.ok(probes >= 12);
  assert.equal(JSON.stringify(preparedInput), saved);
  assert.equal(JSON.stringify(source), snapshot);
});
