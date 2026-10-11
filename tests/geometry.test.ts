import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrintModel,
  validatePrintMesh,
} from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { BBox, OverpassElement } from "../src/types/osm";
import type { Point2D } from "../src/types/geometry";
import { PRINT_LAYERS, type PrintInput } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";
import { createDemoData, DEMO_BBOX } from "../src/lib/demo";

const bbox: BBox = [0, 0, 0.001, 0.001];
const projection = createProjectionForBbox(bbox);
function geometry(points: Point2D[], closed = true) {
  const ring = closed ? [...points, points[0]] : points;
  return ring.map(([x, y]) => {
    const [lon, lat] = projection.unproject(x, y);
    return { lat, lon };
  });
}
function building(
  points: Point2D[],
  tags: Record<string, string> = {},
  id = 1,
): OverpassElement {
  return {
    type: "way",
    id,
    geometry: geometry(points),
    tags: { building: "yes", height: "10", ...tags },
  };
}
function input(elements: OverpassElement[] = []): PrintInput {
  return {
    osmData: { elements },
    bbox,
    scale: 1000,
    elevationGrid: null,
    settings: structuredClone(DEFAULT_MODEL_SETTINGS),
  };
}
const square: Point2D[] = [
  [-20, -20],
  [20, -20],
  [20, 20],
  [-20, 20],
];
const close = (a: number, b: number, tolerance = 0.02) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test("base and buildings form a single closed positive solid in millimetres", async () => {
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(input([building(square)]));
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.components, 1);
  close(model.dimensions.heightMm, 13);
  close(assertClosedSolid(model) - assertClosedSolid(baseline), 40 * 40 * 10);
  assert.equal(
    Math.min(...model.positions.filter((_, index) => index % 3 === 2)),
    0,
  );
});

test("features crossing the selection are clipped and capped", async () => {
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(
    input([
      building([
        [40, -10],
        [80, -10],
        [80, 10],
        [40, 10],
      ]),
    ]),
  );
  const halfWidth = model.dimensions.widthMm / 2;
  for (let i = 0; i < model.positions.length; i += 3)
    assert.ok(Math.abs(model.positions[i]) <= halfWidth + 0.0001);
  close(
    assertClosedSolid(model) - assertClosedSolid(baseline),
    (halfWidth - 40) * 20 * 10,
  );
});

test("courtyards remain open above the continuous socle", async () => {
  const hole: Point2D[] = [
    [-10, -10],
    [-10, 10],
    [10, 10],
    [10, -10],
  ];
  const relation: OverpassElement = {
    type: "relation",
    id: 1,
    tags: { type: "multipolygon", building: "yes", height: "8" },
    members: [
      { type: "way", role: "outer", geometry: geometry(square) },
      { type: "way", role: "inner", geometry: geometry(hole) },
    ],
  };
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(input([relation]));
  close(
    assertClosedSolid(model) - assertClosedSolid(baseline),
    (1600 - 400) * 8,
  );
  assert.equal(model.stats.buildingCount, 1);
});

test("terrain, routes and parks share a watertight supported boundary", async () => {
  const data = input([
    building(square),
    {
      type: "way",
      id: 2,
      tags: { highway: "residential" },
      geometry: geometry(
        [
          [-80, -30],
          [0, -10],
          [80, 15],
        ],
        false,
      ),
    },
    {
      type: "way",
      id: 3,
      tags: { leisure: "park" },
      geometry: geometry([
        [-40, 10],
        [-25, 10],
        [-25, 40],
        [-40, 40],
      ]),
    },
  ]);
  data.settings.base.topographyEnabled = true;
  data.settings.features.roads.heightMm = 4;
  data.elevationGrid = {
    rows: 3,
    cols: 3,
    points: [0, 2, 4, 2, 4, 6, 4, 6, 8],
    minElev: 0,
    maxElev: 8,
    south: 0,
    west: 0,
    north: 0.001,
    east: 0.001,
  };
  const model = await buildPrintModel(data);
  assertClosedSolid(model);
  assert.equal(model.stats.components, 1);
  assert.equal(model.stats.roadCount, 1);
  assert.equal(model.stats.parkCount, 1);
  assert.ok(model.dimensions.heightMm > 13);
});

test("roof shapes use explicit data and remain closed", async () => {
  const baseline = await buildPrintModel(input());
  const implicit = await buildPrintModel(input([building(square)]));
  const explicit = await buildPrintModel(
    input([building(square, { "roof:shape": "gabled", "roof:height": "3" })]),
  );
  close(assertClosedSolid(implicit) - assertClosedSolid(baseline), 16000);
  close(assertClosedSolid(explicit) - assertClosedSolid(baseline), 1600 * 8.5);
  close(explicit.dimensions.heightMm, 13);
});

test("minimum printable footprints remove sub-resolution clutter", async () => {
  const model = await buildPrintModel(
    input([
      building(square),
      building(
        [
          [30, 30],
          [30.2, 30],
          [30.2, 30.2],
          [30, 30.2],
        ],
        {},
        2,
      ),
    ]),
  );
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.discardedFeatures, 1);
  assertClosedSolid(model);
});

test("buildings sharing just a corner receive a finite printable connection", async () => {
  const model = await buildPrintModel(
    input([
      building(
        [
          [-20, -20],
          [0, -20],
          [0, 0],
          [-20, 0],
        ],
        {},
        1,
      ),
      building(
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
        ],
        {},
        2,
      ),
    ]),
  );
  assertClosedSolid(model);
  assert.equal(model.stats.buildingCount, 2);
  assert.equal(model.stats.components, 1);
});

test("nature boundaries touching buildings and water avoid four-face edges", async () => {
  const data = input([
    building(square),
    {
      type: "way",
      id: 2,
      tags: { leisure: "park" },
      geometry: geometry([
        [20, 20],
        [40, 20],
        [40, 40],
        [20, 40],
      ]),
    },
    {
      type: "way",
      id: 3,
      tags: { natural: "water" },
      geometry: geometry([
        [30, 10],
        [40, 10],
        [40, 20],
        [30, 20],
      ]),
    },
  ]);
  const model = await buildPrintModel(data);
  assertClosedSolid(model);
  assert.equal(model.stats.parkCount, 1);
  assert.equal(model.stats.waterCount, 1);
});

test("a rejected building does not erase the park beneath its footprint", async () => {
  const park: OverpassElement = {
    type: "way",
    id: 2,
    tags: { leisure: "park" },
    geometry: geometry([
      [-45, -45],
      [45, -45],
      [45, 45],
      [-45, 45],
    ]),
  };
  const baselineInput = input([park]);
  baselineInput.settings.features.buildings.minHeightM = 2;
  const rejectedInput = input([park, building(square, { height: "1" })]);
  rejectedInput.settings.features.buildings.minHeightM = 2;
  const baseline = await buildPrintModel(baselineInput);
  const rejected = await buildPrintModel(rejectedInput);
  assert.equal(rejected.stats.buildingCount, 0);
  close(assertClosedSolid(rejected), assertClosedSolid(baseline));
});

test("terrain peaks outside a concave footprint do not raise its roof", async () => {
  const data = input([
    building([
      [-40, -40],
      [40, -40],
      [40, -25],
      [-25, -25],
      [-25, 40],
      [-40, 40],
    ]),
  ]);
  data.settings.base.topographyEnabled = true;
  data.elevationGrid = {
    rows: 3,
    cols: 3,
    points: [0, 0, 0, 0, 100, 0, 0, 0, 0],
    minElev: 0,
    maxElev: 100,
    south: 0,
    west: 0,
    north: 0.001,
    east: 0.001,
  };
  const model = await buildPrintModel(data);
  let roof = 0;
  for (let i = 0; i < model.indices.length; i += 3)
    if (model.faceLayers[i / 3] === PRINT_LAYERS.indexOf("buildings")) {
      for (const index of model.indices.subarray(i, i + 3))
        roof = Math.max(roof, model.positions[index * 3 + 2]);
    }
  // The nearest building edge is 25 mm from the central peak on a 55.597 mm cell.
  const expected = 3 + (1 - 25 / (model.dimensions.widthMm / 2)) * 100 + 10;
  close(roof, expected);
  assert.ok(roof < 80);
  assertClosedSolid(model);
});

test("heights inferred from level counts are labelled as estimates", async () => {
  const element = building(square, { "building:levels": "3" });
  delete element.tags!.height;
  const model = await buildPrintModel(input([element]));
  assert.equal(model.stats.estimatedHeights, 1);
  assert.ok(
    model.warnings.some((warning) => warning.includes("hauteur estimée")),
  );
});

test("real tiled intersections close cuts and preserve material volume", async () => {
  const data = input([
    building([
      [-30, -10],
      [30, -10],
      [30, 25],
      [-30, 25],
    ]),
  ]);
  data.settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel(data);
  assert.equal(model.tiles.length, 4);
  const volume = assertClosedSolid(model);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  close(volume, tileVolume);
  assert.ok(
    model.tiles.every((tile) => tile.widthMm < model.dimensions.widthMm),
  );
  const first = Array.from(model.tiles[0].positions).join(",");
  assert.notEqual(first, Array.from(model.tiles[2].positions).join(","));
});

test("rounded frame is a real closed solid joined to the base", async () => {
  const data = input();
  data.settings.base.frame.enabled = true;
  data.settings.base.frame.rounded = true;
  const model = await buildPrintModel(data);
  assertClosedSolid(model);
  close(model.dimensions.widthMm, 111.194923);
  assert.equal(model.stats.components, 1);
});

test("full demo terrain and tiles stay closed after coincident feature unions", async () => {
  const demo = createDemoData();
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 1 };
  const model = await buildPrintModel({
    ...demo,
    bbox: DEMO_BBOX,
    scale: 4500,
    settings,
  });
  close(
    assertClosedSolid(model),
    model.tiles.reduce((sum, tile) => sum + assertClosedSolid(tile), 0),
    0.04,
  );
  assert.ok(model.stats.buildingCount > 20);
  assert.deepEqual(model.sources, ["Démonstration synthétique locale"]);
});

test("a small geographic zone can be printed at scales below one to one hundred", async () => {
  const data = input();
  data.bbox = [0, 0, 0.00018, 0.00018];
  data.scale = 33;
  const model = await buildPrintModel(data);
  assert.ok(model.dimensions.widthMm > 600 && model.dimensions.widthMm < 620);
  assertClosedSolid(model);
});

test("malformed physical dimensions reject before geometry construction", async () => {
  const data = input();
  data.settings.print.minFeatureMm = Number.NaN;
  await assert.rejects(buildPrintModel(data), /profil/);
  data.settings.print.minFeatureMm = 0.8;
  data.settings.base.grid.rows = 1.5;
  await assert.rejects(buildPrintModel(data), /grille/);
});

test("production validation rejects open, reversed and collapsed exported faces", async () => {
  const model = await buildPrintModel(input());
  const open = {
    ...model,
    indices: model.indices.slice(3),
    faceLayers: model.faceLayers.slice(1),
  };
  assert.throws(() => validatePrintMesh(open), /jonction/);
  const reversed = { ...model, indices: model.indices.slice() };
  [reversed.indices[0], reversed.indices[1]] = [
    reversed.indices[1],
    reversed.indices[0],
  ];
  assert.throws(() => validatePrintMesh(reversed), /jonction/);
  const collapsed = { ...model, positions: model.positions.slice() };
  const a = model.indices[0] * 3,
    b = model.indices[1] * 3;
  collapsed.positions.set(collapsed.positions.subarray(a, a + 3), b);
  assert.throws(() => validatePrintMesh(collapsed), /trop petite/);
  const collinear = { ...model, positions: model.positions.slice() };
  const c = model.indices[2] * 3;
  for (let axis = 0; axis < 3; axis++)
    collinear.positions[c + axis] =
      (collinear.positions[a + axis] + collinear.positions[b + axis]) / 2;
  assert.throws(() => validatePrintMesh(collinear), /collinéaire/);
});
