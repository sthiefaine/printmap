import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { BBox, OverpassElement } from "../src/types/osm";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const saved = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/montpellier-polygone-indoor-stairs.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PrintInput;
const roofs = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/montpellier-polygone-roof-fallback.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Omit<PrintInput, "settings">;

function buildingHeightAt(mesh: PrintMesh, x: number, y: number) {
  let height = -Infinity;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (det <= 1e-12) continue;
    const wb = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
    const wc = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
    const wa = 1 - wb - wc;
    if (Math.min(wa, wb, wc) >= -1e-7)
      height = Math.max(height, wa * a[2] + wb * b[2] + wc * c[2]);
  }
  return height;
}

test("Polygone indoor escalators preserve the surveyed roof and four closed tiles on saved RGE terrain", async () => {
  const building = roofs.osmData.elements.find(
    (element) => element.tags?.["printmap:source_id"] === "MMM/B106856",
  )!;
  assert.equal(building.roofSurfaces?.length, 219);
  assert.deepEqual(
    saved.osmData.elements.map((element) => element.id),
    [473049850, 473049855],
  );
  assert.ok(
    saved.osmData.elements.every(
      (element) =>
        element.tags?.indoor === "steps" && element.tags.conveying === "yes",
    ),
  );
  const baseline = await buildPrintModel({
    ...saved,
    osmData: { elements: [building] },
  });
  const model = await buildPrintModel({
    ...saved,
    osmData: { elements: [building, ...saved.osmData.elements] },
  });
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.staircaseCount, 0);
  assert.equal(model.stats.roadCount, 0);
  assert.ok(
    Math.abs(assertClosedSolid(model) - assertClosedSolid(baseline)) < 0.000001,
    "indoor routes remove no outside building or terrain material",
  );

  // The genuine sloping panel 24 was cut down to DEM Z=5.361273 mm by the
  // indoor escalator; its source triangle has a barycentre at Z=8.263175 mm.
  const points = [5, 3, 4].map(
    (index) => building.roofSurfaces![24].outer[index],
  );
  const sf = 1000 / saved.scale;
  const projection = createProjectionForBbox(saved.bbox);
  const [x, y] = projection
    .project(
      points.reduce((sum, point) => sum + point.lon, 0) / 3,
      points.reduce((sum, point) => sum + point.lat, 0) / 3,
    )
    .map((value) => value * sf);
  const expected =
    saved.settings.base.basePlateThicknessMm +
    (points.reduce((sum, point) => sum + point.elevation, 0) / 3 -
      saved.elevationGrid!.minElev) *
      sf *
      saved.settings.base.elevationExaggeration;
  assert.ok(Math.abs(buildingHeightAt(model, x, y) - expected) < 0.03);
  assert.equal(model.tiles.length, 4);
  const volumes = model.tiles.map(assertClosedSolid);
  assert.ok(
    Math.abs(
      volumes.reduce((sum, volume) => sum + volume, 0) - model.stats.volumeMm3,
    ) /
      model.stats.volumeMm3 <
      0.0001,
  );
  const tile = model.tiles.find((part) => {
    const x0 = -model.dimensions.widthMm / 2 + part.col * part.widthMm;
    const y0 = -model.dimensions.depthMm / 2 + part.row * part.depthMm;
    return x > x0 && x < x0 + part.widthMm && y > y0 && y < y0 + part.depthMm;
  })!;
  assert.ok(tile);
  const tileX =
    x + model.dimensions.widthMm / 2 - (tile.col + 0.5) * tile.widthMm;
  const tileY =
    y + model.dimensions.depthMm / 2 - (tile.row + 0.5) * tile.depthMm;
  assert.ok(Math.abs(buildingHeightAt(tile, tileX, tileY) - expected) < 0.03);
});

test("explicit indoor stair tags are excluded while outdoor stairs and escalators stay printable", async () => {
  const bbox: BBox = [0, 0, 0.001, 0.001];
  const projection = createProjectionForBbox(bbox);
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.features.roads.filter = "minor";
  settings.features.roads.footpathsEnabled = false;
  const cases: { tags: Record<string, string>; expected: number }[] = [
    { tags: { indoor: "yes" }, expected: 0 },
    { tags: { location: "indoor" }, expected: 0 },
    { tags: { indoor: "no", conveying: "yes" }, expected: 1 },
    { tags: {}, expected: 1 },
  ];
  for (const { tags, expected } of cases) {
    const stair: OverpassElement = {
      type: "way",
      id: 1,
      tags: {
        highway: "steps",
        step_count: "10",
        "step:height": "0.2",
        incline: "up",
        ...tags,
      },
      geometry: [-10, 10].map((x) => {
        const [lon, lat] = projection.unproject(x, 0);
        return { lon, lat };
      }),
    };
    const model = await buildPrintModel({
      bbox,
      scale: 1000,
      settings,
      elevationGrid: null,
      osmData: { elements: [stair] },
    });
    assert.equal(model.stats.staircaseCount, expected, JSON.stringify(tags));
    assert.equal(model.stats.roadCount, expected, JSON.stringify(tags));
    assertClosedSolid(model);
  }
});
