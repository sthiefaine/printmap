import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import {
  buildPrintModel,
  validatePrintMesh,
} from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { pointInPolygon } from "../src/lib/polygon/point-in-polygon";
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

test("tagged roof families retain slopes and curves as closed printable solids", async () => {
  const baseline = await buildPrintModel(input());
  const flatVolume = assertClosedSolid(baseline) + 16000;
  for (const shape of [
    " GABLED ",
    "pitched",
    "skillion",
    "hipped",
    "pyramidal",
    "mansard",
    "half-hipped",
    "gambrel",
    "saltbox",
    "round",
    "dome",
    "cone",
    "onion",
  ]) {
    const model = await buildPrintModel(
      input([
        building(square, {
          "roof:shape": shape,
          "roof:height": "3",
          "roof:direction": "N",
        }),
      ]),
    );
    close(model.dimensions.heightMm, 13);
    assert.ok(
      assertClosedSolid(model) < flatVolume - 100,
      `${shape} must retain its roof relief`,
    );
    assert.ok(
      !model.warnings.some((warning) =>
        warning.includes("représentée(s) à plat"),
      ),
      shape,
    );
  }
});

test("roof bearings describe runoff and across orientation rotates the ridge", async () => {
  const topAt = (
    model: Awaited<ReturnType<typeof buildPrintModel>>,
    x: number,
    y: number,
  ) => {
    let top = -Infinity;
    for (let i = 0; i < model.positions.length; i += 3)
      if (
        Math.abs(model.positions[i] - x) < 0.01 &&
        Math.abs(model.positions[i + 1] - y) < 0.01
      )
        top = Math.max(top, model.positions[i + 2]);
    return top;
  };
  const north = await buildPrintModel(
    input([
      building(square, {
        "roof:shape": "skillion",
        "roof:height": "3",
        "roof:direction": "N",
      }),
    ]),
  );
  close(topAt(north, 20, -20), 13);
  close(topAt(north, 20, 20), 10);
  const south = await buildPrintModel(
    input([
      building(square, {
        "roof:shape": "skillion",
        "roof:height": "3",
        "roof:direction": "180",
      }),
    ]),
  );
  close(topAt(south, 20, -20), 10);
  close(topAt(south, 20, 20), 13);
  const rectangle: Point2D[] = [
    [-30, -10],
    [30, -10],
    [30, 10],
    [-30, 10],
  ];
  const across = await buildPrintModel(
    input([
      building(rectangle, {
        "roof:shape": "gabled",
        "roof:height": "3",
        "roof:orientation": "across",
      }),
    ]),
  );
  close(topAt(across, 0, 10), 13);
  close(topAt(across, 30, 10), 10);
  const east = await buildPrintModel(
    input([
      building(rectangle, {
        "roof:shape": "gabled",
        "roof:height": "3",
        "roof:direction": "E",
      }),
    ]),
  );
  close(topAt(east, 0, 10), 13);
  for (const model of [north, south, across, east]) assertClosedSolid(model);
});

test("a tagged roof angle controls pitch instead of the fallback ratio", async () => {
  const model = await buildPrintModel(
    input([
      building(square, {
        height: "50",
        "roof:shape": "gabled",
        "roof:angle": "30",
        "roof:direction": "N",
      }),
    ]),
  );
  close(model.dimensions.heightMm, 53);
  const roofEave = 53 - 20 * Math.tan(Math.PI / 6);
  const eaveVertices: number[] = [];
  for (let i = 0; i < model.positions.length; i += 3)
    if (
      Math.abs(Math.abs(model.positions[i + 1]) - 20) < 0.01 &&
      model.positions[i + 2] > 4
    )
      eaveVertices.push(model.positions[i + 2]);
  assert.ok(eaveVertices.some((z) => Math.abs(z - roofEave) < 0.01));
  assertClosedSolid(model);
});

test("tagged roofs on courtyards and concave footprints retain their exact holes", async () => {
  const courtyard: OverpassElement = {
    type: "relation",
    id: 99,
    tags: {
      type: "multipolygon",
      building: "yes",
      height: "10",
      "roof:shape": "hipped",
      "roof:height": "3",
    },
    members: [
      { type: "way", role: "outer", geometry: geometry(square) },
      {
        type: "way",
        role: "inner",
        geometry: geometry([
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ]),
      },
    ],
  };
  const model = await buildPrintModel(input([courtyard]));
  assertClosedSolid(model);
  assert.ok(model.dimensions.heightMm > 12);
  for (let i = 0; i < model.positions.length; i += 3)
    if (
      Math.abs(model.positions[i]) < 4.9 &&
      Math.abs(model.positions[i + 1]) < 4.9
    )
      assert.ok(model.positions[i + 2] <= 3.01);
  const concave = await buildPrintModel(
    input([
      building(
        [
          [-20, -20],
          [20, -20],
          [20, -10],
          [-10, -10],
          [-10, 20],
          [-20, 20],
        ],
        { "roof:shape": "gabled", "roof:height": "3" },
      ),
    ]),
  );
  close(concave.dimensions.heightMm, 13);
  assertClosedSolid(concave);
});

test("measured roof panels override flat tags and preserve their actual ridge heights", async () => {
  const measured = (points: [number, number, number][]) =>
    points.map(([x, y, elevation]) => {
      const [lon, lat] = projection.unproject(x, y);
      return { lon, lat, elevation };
    });
  const element = building(square, { "roof:shape": "flat" });
  element.groundElevation = 100;
  element.roofSurfaces = [
    {
      outer: measured([
        [-20, -20, 107],
        [20, -20, 107],
        [20, 0, 110],
        [-20, 0, 110],
      ]),
      holes: [],
    },
    {
      outer: measured([
        [-20, 0, 110],
        [20, 0, 110],
        [20, 20, 107],
        [-20, 20, 107],
      ]),
      holes: [],
    },
  ];
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(input([element]));
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.taggedRoofCount, 0);
  close(model.dimensions.heightMm, 13);
  close(assertClosedSolid(model) - assertClosedSolid(baseline), 1600 * 8.5);
  const flatInput = input([element]);
  flatInput.settings.features.buildings.roofs = false;
  const flat = await buildPrintModel(flatInput);
  assert.equal(flat.stats.realRoofCount, 0);
  close(assertClosedSolid(flat) - assertClosedSolid(baseline), 16000);
});

test("measured roof panel holes remain courtyards and incomplete data has a declared fallback", async () => {
  const hole: Point2D[] = [
    [-5, -5],
    [5, -5],
    [5, 5],
    [-5, 5],
  ];
  const measured = (points: Point2D[]) =>
    geometry(points).map((p) => ({ ...p, elevation: 110 }));
  const element: OverpassElement = {
    type: "relation",
    id: 100,
    tags: { type: "multipolygon", building: "yes", height: "10" },
    groundElevation: 100,
    roofSurfaces: [{ outer: measured(square), holes: [measured(hole)] }],
    members: [
      { type: "way", role: "outer", geometry: geometry(square) },
      { type: "way", role: "inner", geometry: geometry(hole) },
    ],
  };
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(input([element]));
  assert.equal(model.stats.realRoofCount, 1);
  close(assertClosedSolid(model) - assertClosedSolid(baseline), 15000);
  const partial = building(square);
  partial.groundElevation = 100;
  partial.roofSurfaces = [
    {
      outer: measured([
        [-20, -20],
        [20, -20],
        [20, 0],
        [-20, 0],
      ]),
      holes: [],
    },
  ];
  const fallback = await buildPrintModel(input([partial]));
  assert.equal(fallback.stats.realRoofCount, 0);
  assert.ok(
    fallback.warnings.some((warning) =>
      warning.includes("mesurée(s) incomplète(s)"),
    ),
  );
  assertClosedSolid(fallback);
});

test("real Montpellier roof panels remove zero-volume survey shells before Float32 export", async () => {
  const elements = JSON.parse(
    readFileSync(
      new URL("./fixtures/measured-roof-shell.json", import.meta.url),
      "utf8",
    ),
  ) as OverpassElement[];
  const data = input(elements);
  data.bbox = [43.608, 3.872, 43.616, 3.884];
  data.scale = 4830;
  data.settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel(data);
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.components, 1);
  assertClosedSolid(model);
  for (const tile of model.tiles) assertClosedSolid(tile);
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

test("actual surveyed roofs and mapped streets retain measured planes after omitting a sub-resolution fragment", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/montpellier-roof-road-contact.json", import.meta.url),
      "utf8",
    ),
  ) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel({ ...fixture, settings });
  assert.equal(model.stats.components, 1);
  assert.equal(
    model.stats.buildingCount,
    4,
    "all four measured building outlines remain",
  );
  assert.equal(model.stats.realRoofCount, 4);
  assert.equal(model.stats.roadCount, 3);
  assert.equal(model.stats.discardedFeatures, 1);
  assert.ok(model.warnings.some((warning) => /fragment.*écart/i.test(warning)));
  type Point = [number, number, number];
  type Triangle = [Point, Point, Point];
  const sf = 1000 / fixture.scale;
  const project = createProjectionForBbox(fixture.bbox);
  const upperTriangles: Triangle[] = [];
  for (let at = 0; at < model.indices.length; at += 3) {
    if (PRINT_LAYERS[model.faceLayers[at / 3]] !== "buildings") continue;
    const triangle = Array.from(
      model.indices.subarray(at, at + 3),
      (id) => Array.from(model.positions.subarray(id * 3, id * 3 + 3)) as Point,
    ) as Triangle;
    const [a, b, c] = triangle;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12)
      upperTriangles.push(triangle);
  }
  const topAt = (triangles: Triangle[], x: number, y: number) => {
    let highest = -Infinity;
    for (const [a, b, c] of triangles) {
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(det) < 1e-12) continue;
      const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
      const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
      if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8)
        highest = Math.max(
          highest,
          a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]),
        );
    }
    return highest;
  };
  for (const building of fixture.osmData.elements.filter(
    (item) => item.roofSurfaces,
  )) {
    const triangles: Triangle[] = [];
    for (const panel of building.roofSurfaces!) {
      const points = [panel.outer, ...panel.holes]
        .flat()
        .map((point): Point => {
          const [x, y] = project.project(point.lon, point.lat);
          return [
            x * sf,
            y * sf,
            settings.base.basePlateThicknessMm +
              (point.elevation - fixture.elevationGrid!.minElev) * sf,
          ];
        });
      const holeIndices: number[] = [];
      let offset = panel.outer.length;
      for (const hole of panel.holes) {
        holeIndices.push(offset);
        offset += hole.length;
      }
      const indices = earcut(
        points.flatMap(([x, y]) => [x, y]),
        holeIndices,
      );
      for (let at = 0; at < indices.length; at += 3)
        triangles.push(
          indices.slice(at, at + 3).map((id) => points[id]) as Triangle,
        );
    }
    // The dense-scene memory optimisation must leave this small site's native
    // order unchanged. Its one tiny detached fragment remains omitted and
    // reported; the actual measured building planes remain intact.
    const candidates = triangles
      .map((triangle) => {
        const [a, b, c] = triangle;
        const area = Math.abs(
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        );
        return { triangle, area };
      })
      .sort((a, b) => b.area - a.area);
    let checked = false;
    for (const { triangle, area } of candidates) {
      if (area < 0.001) continue;
      const probes = [
        [1 / 3, 1 / 3, 1 / 3],
        [1 / 2, 1 / 4, 1 / 4],
      ].map(
        (weights) =>
          [0, 1, 2].map((axis) =>
            triangle.reduce(
              (sum, point, k) => sum + point[axis] * weights[k],
              0,
            ),
          ) as Point,
      );
      if (
        probes.some(
          ([x, y, z]) =>
            Math.abs(x) > model.dimensions.widthMm / 2 - 0.03 ||
            Math.abs(y) > model.dimensions.depthMm / 2 - 0.03 ||
            Math.abs(topAt(triangles, x, y) - z) > 1e-6,
        )
      )
        continue;
      const heights = probes.map(([x, y, z]) => {
        const height = topAt(upperTriangles, x, y);
        close(height, z, 0.03);
        return height;
      });
      close(heights[1] - heights[0], probes[1][2] - probes[0][2], 0.02);
      checked = true;
      break;
    }
    assert.ok(
      checked,
      `${building.tags!["printmap:source_id"]} has an interior measured plane in the exported solid`,
    );
  }
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(
    Math.abs(tileVolume - volume) / volume < 1e-4,
    "the four closed tiles retain the complete printable volume",
  );
});

test("neighbouring surveyed roofs keep their measured heights and slopes with exact source contours", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-coplanar-roof-contact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel({ ...fixture, settings });
  assert.equal(model.stats.components, 1);
  assert.equal(model.stats.buildingCount, 2);
  assert.equal(
    model.stats.realRoofCount,
    2,
    "both measured roofs remain without a flat fallback",
  );
  assert.equal(model.stats.discardedFeatures, 0);
  type Point = [number, number, number];
  type Triangle = [Point, Point, Point];
  const sf = 1000 / fixture.scale;
  const project = createProjectionForBbox(fixture.bbox);
  const upperTriangles: Triangle[] = [];
  const sourceFootprints = fixture.osmData.elements.map((building) => {
    const rings = (building.members ?? []).map((member) => ({
      role: member.role,
      ring: (member.geometry ?? []).map((point): Point2D => {
        const [x, y] = project.project(point.lon, point.lat);
        return [x * sf, y * sf];
      }),
    }));
    return (x: number, y: number) =>
      rings.some(
        ({ role, ring }) => role === "outer" && pointInPolygon(x, y, ring),
      ) &&
      !rings.some(
        ({ role, ring }) => role === "inner" && pointInPolygon(x, y, ring),
      );
  });
  for (let at = 0; at < model.indices.length; at += 3) {
    if (PRINT_LAYERS[model.faceLayers[at / 3]] !== "buildings") continue;
    const triangle = Array.from(
      model.indices.subarray(at, at + 3),
      (id) => Array.from(model.positions.subarray(id * 3, id * 3 + 3)) as Point,
    ) as Triangle;
    const [a, b, c] = triangle;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12)
      upperTriangles.push(triangle);
  }
  const surfaceAt = (triangles: Triangle[], x: number, y: number) => {
    let top = -Infinity;
    for (const [a, b, c] of triangles) {
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(det) < 1e-12) continue;
      const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
      const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
      if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
        top = Math.max(top, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
    }
    return top;
  };
  // Interior source triangles from two inclined panels on each building.
  // These vertex indices avoid courtyards, overhanging edges and vertical faces;
  // they are independent of the triangulation or repair used by the generator.
  const probes = [
    { building: 0, panel: 30, vertices: [4, 5, 6] },
    { building: 0, panel: 31, vertices: [7, 9, 10] },
    { building: 1, panel: 4, vertices: [6, 0, 1] },
    { building: 1, panel: 5, vertices: [2, 5, 0] },
  ];
  for (const probe of probes) {
    const source = fixture.osmData.elements[probe.building];
    const panel = source.roofSurfaces![probe.panel];
    const triangle = probe.vertices.map((index): Point => {
      const point = panel.outer[index];
      const [x, y] = project.project(point.lon, point.lat);
      return [
        x * sf,
        y * sf,
        settings.base.basePlateThicknessMm +
          (point.elevation - fixture.elevationGrid!.minElev) * sf,
      ];
    }) as Triangle;
    const [a, b, c] = triangle;
    assert.ok(
      Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) >
        0.001,
    );
    const expected: number[] = [],
      actual: number[] = [];
    for (const weights of [
      [1 / 3, 1 / 3, 1 / 3],
      [1 / 2, 1 / 4, 1 / 4],
    ]) {
      const [x, y, z] = [0, 1, 2].map((axis) =>
        triangle.reduce(
          (sum, point, index) => sum + point[axis] * weights[index],
          0,
        ),
      );
      assert.ok(Math.abs(x) < model.dimensions.widthMm / 2 - 0.03);
      assert.ok(Math.abs(y) < model.dimensions.depthMm / 2 - 0.03);
      assert.ok(
        sourceFootprints[probe.building](x, y),
        "the probe is inside the exact source footprint and outside its courtyard",
      );
      const height = surfaceAt(upperTriangles, x, y);
      close(height, z, 0.03);
      expected.push(z);
      actual.push(height);
    }
    close(actual[1] - actual[0], expected[1] - expected[0], 0.02);
  }
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
});
