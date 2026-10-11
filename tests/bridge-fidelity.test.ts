import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { PRINT_LAYERS, type PrintInput, type PrintMesh } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/montpellier-vialleton-approaches.json", import.meta.url), "utf8")) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid"> & { fullTerrainGrid: PrintInput["elevationGrid"] };

/** Intersect the actual road triangles with a vertical line, not a helper mesh. */
function roadHeights(mesh: PrintMesh, x: number, y: number) {
  const result: number[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "roads") continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), index => Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)));
    const determinant = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-9) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      result.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return result;
}

function crossesFace(mesh: PrintMesh, from: number[], to: number[]) {
  const sub = (a: number[], b: number[]) => a.map((value, i) => value - b[i]);
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const direction = sub(to, from);
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), index => Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)));
    const e1 = sub(b, a), e2 = sub(c, a), h = cross(direction, e2), determinant = dot(e1, h);
    if (Math.abs(determinant) < 1e-10) continue;
    const s = sub(from, a), u = dot(s, h) / determinant;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = dot(direction, q) / determinant;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) / determinant;
    if (t > 1e-6 && t < 1 - 1e-6) return true;
  }
  return false;
}

test("the real Vialleton bridge carries two continuous street levels independent of printing thickness", async () => {
  const lowerZ = 10.4967195316;
  const deckZ = 3 + (51.2 - fixture.elevationGrid!.minElev) * 1000 / fixture.scale;
  for (const minFeatureMm of [0.4, 1.2]) {
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    settings.base.grid = { cols: 2, rows: 2 };
    settings.features.roads.filter = "all";
    settings.features.roads.footpathsEnabled = true;
    settings.print.minFeatureMm = minFeatureMm;
    const model = await buildPrintModel({ ...fixture, elevationGrid: fixture.fullTerrainGrid, settings });
    assert.equal(model.stats.reconstructedBridgeCount, 1);
    assert.equal(model.stats.roadCount, 7, "the two exposed tunnel ways are restored together with their outlets");
    const heights = roadHeights(model, 50.52935514535, -21.52065398514);
    assert.ok(heights.some(z => Math.abs(z - lowerZ) < 0.002), `the boulevard remains at its estimated DEM grade under the arch: ${heights.join(", ")}`);
    assert.ok(heights.some(z => Math.abs(z - deckZ) < 0.002), "Rue Foch is flush with the documented deck rather than hidden by a white slab");
    assert.ok(deckZ - lowerZ > 5 * 1000 / fixture.scale, "the documented passage fits below the deck");
    assert.equal(crossesFace(model, [49.5, -35, lowerZ + 0.5], [51.55, -8, lowerZ + 0.5]), false,
      "the actual exported arch and both approaches leave a continuous open passage above the lower road");
    const volume = assertClosedSolid(model);
    const tileVolume = model.tiles.reduce((sum, tile) => sum + assertClosedSolid(tile), 0);
    assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
  }
});
