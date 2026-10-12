import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import {
  salonPrintLayouts,
  salonLayoutSettings,
  SAINT_ETIENNE_STADIUM_BBOX,
} from "../src/lib/print-layout";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { PRINT_LAYERS, type PrintMesh } from "../src/types/print";
import type { MapDataResponse } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

const source = JSON.parse(
  readFileSync(
    new URL("./fixtures/saint-etienne-salon-roads.json", import.meta.url),
    "utf8",
  ),
) as MapDataResponse;
const layout = salonPrintLayouts(SAINT_ETIENNE_STADIUM_BBOX).find(
  (item) => item.count === 2,
)!;
const settings = () =>
  salonLayoutSettings(structuredClone(DEFAULT_MODEL_SETTINGS), layout);
const modelInput = (data = source) => ({
  ...data,
  bbox: SAINT_ETIENNE_STADIUM_BBOX,
  scale: layout.scale,
  settings: settings(),
});

function topAt(mesh: PrintMesh, x: number, y: number): number {
  let highest = -Infinity;
  const p = mesh.positions;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const a = mesh.indices[at] * 3;
    const b = mesh.indices[at + 1] * 3;
    const c = mesh.indices[at + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1];
    const determinant = ux * vy - uy * vx;
    if (determinant <= 1e-14) continue;
    const dx = x - p[a],
      dy = y - p[a + 1];
    const u = (dx * vy - dy * vx) / determinant;
    const v = (ux * dy - uy * dx) / determinant;
    if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
    highest = Math.max(
      highest,
      p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]),
    );
  }
  return highest;
}

function localRoadProbes(mesh: PrintMesh) {
  const probes: [number, number, number][] = [];
  for (let t = 0; t < mesh.faceLayers.length; t++) {
    if (PRINT_LAYERS[mesh.faceLayers[t]] !== "roads") continue;
    const indices = Array.from(mesh.indices.subarray(t * 3, t * 3 + 3));
    const p = indices.map((index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const [a, b, c] = p;
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (nz <= 1e-9) continue;
    const centre = [0, 1, 2].map((axis) => (a[axis] + b[axis] + c[axis]) / 3);
    // The actual road/DEM junction is at 4.3872897832 E, 45.4342707735 N.
    // These millimetre coordinates keep the whole original city's projection.
    if (Math.abs(centre[0] + 3.28) > 0.12 || Math.abs(centre[1] + 66.55) > 0.12)
      continue;
    probes.push(centre as [number, number, number]);
  }
  return probes;
}

function assertTiles(model: Awaited<ReturnType<typeof buildPrintModel>>) {
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 2);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(
    Math.abs(tileVolume - volume) / volume < 1e-4,
    "two actual cuts conserve volume",
  );
  for (const tile of model.tiles) {
    assert.ok(Math.abs(tile.widthMm - 145) < 1e-5);
    assert.ok(Math.abs(tile.depthMm - layout.tileHeightMm) < 1e-5);
  }
  for (const mesh of [model, ...model.tiles]) {
    let undersideFaces = 0;
    for (let face = 0; face < mesh.faceLayers.length; face++) {
      const indices = mesh.indices.subarray(face * 3, face * 3 + 3);
      if (
        !Array.from(indices).every(
          (index) => mesh.positions[index * 3 + 2] === 0,
        )
      )
        continue;
      undersideFaces++;
      assert.equal(
        PRINT_LAYERS[mesh.faceLayers[face]],
        "basePlate",
        "the underside stays neutral instead of duplicating the road palette",
      );
    }
    assert.ok(undersideFaces > 0);
  }
  return volume;
}

test("the actual Saint-Étienne road/DEM junction keeps source roofs and closes at the two-plate scale", async () => {
  assert.equal(source.osmData.elements.length, 178);
  const unchanged = JSON.stringify(source);
  const model = await buildPrintModel(modelInput());
  assert.equal(model.stats.components, 1);
  assert.ok(
    model.stats.realRoofCount >= 6,
    "nearby authentic CRAIG roofs remain retained",
  );
  assert.ok(model.stats.roadCount >= 40);
  assert.equal(model.dimensions.widthMm, 145);
  assert.ok(
    Math.abs(
      model.dimensions.depthMm / model.dimensions.widthMm -
        layout.heightMm / layout.widthMm,
    ) < 1e-7,
  );
  assertTiles(model);
  assert.equal(
    JSON.stringify(source),
    unchanged,
    "no source coordinate or datum is changed",
  );
});

test("zero-offset real roads recolour the original sloping ground without changing height or volume", async () => {
  // Isolate the actual road polygons/axes. The two real stairs and surrounding
  // buildings legitimately change volume, so they belong in the first test.
  const roadData: MapDataResponse = {
    ...source,
    osmData: {
      ...source.osmData,
      elements: source.osmData.elements.filter(
        (element) =>
          element.tags?.highway &&
          element.tags.highway !== "steps" &&
          !element.tags.building &&
          !element.tags["building:part"],
      ),
    },
  };
  const ground = await buildPrintModel(
    modelInput({
      ...source,
      osmData: { ...source.osmData, elements: [] },
    }),
  );
  const model = await buildPrintModel(modelInput(roadData));
  const groundVolume = assertTiles(ground);
  const colouredVolume = assertTiles(model);
  assert.ok(
    Math.abs(colouredVolume - groundVolume) < 0.01,
    "a palette partition adds no terrain ribbon",
  );
  const probes = localRoadProbes(model);
  assert.ok(
    probes.length >= 3,
    "the actual failing junction retains its road palette",
  );
  for (const [x, y, z] of probes) {
    const originalZ = topAt(ground, x, y);
    assert.ok(Number.isFinite(originalZ));
    assert.ok(
      Math.abs(z - originalZ) < 1e-5,
      `${z} remains on original DEM ${originalZ}`,
    );
    const tile = model.tiles.find((item) => item.row === 0 && item.col === 0)!;
    const tileCentreY = -model.dimensions.depthMm / 4;
    const tileZ = topAt(tile, x, y - tileCentreY);
    assert.ok(
      Math.abs(tileZ - originalZ) < 1e-5,
      "the exported tile keeps the same ground level",
    );
  }
});
