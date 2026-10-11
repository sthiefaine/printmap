import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { createProjectionForBbox } from "../src/lib/projection";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import type { BBox, OverpassElement } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

const bbox: BBox = [0, 0, 0.001, 0.001];
const projection = createProjectionForBbox(bbox);
function feature(
  id: number,
  tags: Record<string, string>,
  points: number[][],
  closed = true,
): OverpassElement {
  const ring = closed ? [...points, points[0]] : points;
  return {
    type: "way",
    id,
    tags,
    geometry: ring.map(([x, y]) => {
      const [lon, lat] = projection.unproject(x, y);
      return { lat, lon };
    }),
  };
}
const park = feature(1, { leisure: "park" }, [
  [-45, -40],
  [20, -40],
  [20, 40],
  [-45, 40],
]);
const road = feature(
  2,
  { highway: "residential" },
  [
    [-50, 0],
    [50, 0],
  ],
  false,
);
function input(elements: OverpassElement[] = []): PrintInput {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.features.parks.heightMm = 0;
  settings.features.roads.heightMm = 0;
  settings.features.water.heightMm = 0;
  settings.features.sand.heightMm = 0;
  return {
    bbox,
    scale: 1000,
    settings,
    elevationGrid: null,
    osmData: { elements },
  };
}
function upwardVertices(mesh: PrintMesh, layer: string) {
  const vertices: number[][] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[t / 3]] !== layer) continue;
    const points = Array.from(mesh.indices.slice(t, t + 3), (index) =>
      Array.from(mesh.positions.slice(index * 3, index * 3 + 3)),
    );
    const [a, b, c] = points;
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (nz > 1e-8) vertices.push(...points);
  }
  return vertices;
}

test("roads and gardens replace the terrain skin at the exact same level, retaining surface colours", async () => {
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(input([park, road]));
  assert.ok(
    Math.abs(assertClosedSolid(model) - assertClosedSolid(baseline)) < 0.01,
  );
  assert.equal(model.dimensions.heightMm, 3);
  for (const layer of ["roads", "parks"]) {
    const vertices = upwardVertices(model, layer);
    assert.ok(vertices.length > 0, `${layer} has its own coloured surface`);
    for (const vertex of vertices) assert.equal(vertex[2], 3);
  }
});

test("flush landscape surfaces follow the actual sloping terrain without extra ribbons", async () => {
  const data = input([park, road]);
  data.settings.base.topographyEnabled = true;
  data.elevationGrid = {
    rows: 3,
    cols: 3,
    points: [0, 0.45, 0.9, 0.3, 0.75, 1.2, 0.6, 1.05, 1.5],
    minElev: 0,
    maxElev: 1.5,
    south: 0,
    west: 0,
    north: 0.001,
    east: 0.001,
  };
  const baseline = await buildPrintModel({
    ...data,
    osmData: { elements: [] },
  });
  const model = await buildPrintModel(data);
  assert.ok(
    Math.abs(assertClosedSolid(model) - assertClosedSolid(baseline)) < 0.02,
  );
  for (const layer of ["roads", "parks"])
    for (const [x, y, z] of upwardVertices(model, layer)) {
      const terrainZ =
        3 +
        (x / model.dimensions.widthMm + 0.5) * 0.9 +
        (y / model.dimensions.depthMm + 0.5) * 0.6;
      assert.ok(
        Math.abs(z - terrainZ) < 0.00001,
        `${layer}: ${z} follows ${terrainZ}`,
      );
    }
});

test("optional monochrome road engraving removes material rather than covering the ground", async () => {
  const data = input([road]);
  data.settings.features.roads.heightMm = -0.25;
  const baseline = await buildPrintModel(input());
  const model = await buildPrintModel(data);
  assert.ok(assertClosedSolid(model) < assertClosedSolid(baseline));
  for (const vertex of upwardVertices(model, "roads"))
    assert.equal(vertex[2], 2.75);
  assert.equal(model.dimensions.heightMm, 3);
});

test("balanced detail retains pedestrian streets while omitting small footpaths", async () => {
  const pedestrianStreet = feature(
    3,
    { highway: "pedestrian" },
    [
      [-50, 0],
      [50, 0],
    ],
    false,
  );
  const footpath = feature(
    4,
    { highway: "footway" },
    [
      [-50, 20],
      [50, 20],
    ],
    false,
  );
  const model = await buildPrintModel(input([pedestrianStreet, footpath]));
  assertClosedSolid(model);
  assert.equal(model.stats.roadCount, 1);
  const vertices = upwardVertices(model, "roads");
  assert.ok(vertices.length > 0);
  for (const [x, y, z] of vertices) {
    assert.ok(Number.isFinite(x));
    assert.ok(Math.abs(y) < 5, "the small footpath at y=20 is absent");
    assert.equal(z, 3);
  }
});

test("balanced detail builds mapped stair flights as ten horizontal treads in the exported solid", async () => {
  const staircase = feature(
    5,
    {
      highway: "steps",
      step_count: "10",
      "step:height": "0.16",
      incline: "up",
      width: "3",
    },
    [
      [-10, 0],
      [10, 0],
    ],
    false,
  );
  const model = await buildPrintModel(input([staircase]));
  const baseline = await buildPrintModel(input());
  assert.ok(assertClosedSolid(model) > assertClosedSolid(baseline));
  assert.equal(model.stats.staircaseCount, 1);
  assert.equal(model.stats.roadCount, 1);
  const levels = new Set(
    upwardVertices(model, "roads").map((point) => point[2].toFixed(2)),
  );
  assert.equal(levels.size, 10);
  assert.ok(levels.has("3.16") && levels.has("4.60"));
  assert.ok(Math.abs(model.dimensions.heightMm - 4.6) < 0.0001);
});

test("mapped pedestrian plazas replace the full paved area of a park at ground level", async () => {
  const plaza = feature(6, { highway: "pedestrian", area: "yes" }, [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
  ]);
  const model = await buildPrintModel(input([park, plaza]));
  const baseline = await buildPrintModel(input());
  assert.ok(
    Math.abs(assertClosedSolid(model) - assertClosedSolid(baseline)) < 0.01,
  );
  assert.equal(model.stats.roadCount, 1);
  let pavedArea = 0;
  for (let i = 0; i < model.indices.length; i += 3) {
    if (PRINT_LAYERS[model.faceLayers[i / 3]] !== "roads") continue;
    const p = Array.from(model.indices.slice(i, i + 3), (index) =>
      Array.from(model.positions.slice(index * 3, index * 3 + 3)),
    );
    const area =
      ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) -
        (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) /
      2;
    if (area > 0) {
      pavedArea += area;
      for (const point of p) assert.equal(point[2], 3);
    }
  }
  assert.ok(
    Math.abs(pavedArea - 400) < 0.1,
    `the 20×20 square is paved with the one-micron seam overlap, including its centre (${pavedArea})`,
  );
});

test("steps without a measured rise stay on flat ground instead of adding invented blocks", async () => {
  const staircase = feature(
    7,
    { highway: "steps", step_count: "30", incline: "up" },
    [
      [-10, 0],
      [10, 0],
    ],
    false,
  );
  const model = await buildPrintModel(input([staircase]));
  const baseline = await buildPrintModel(input());
  assert.ok(
    Math.abs(assertClosedSolid(model) - assertClosedSolid(baseline)) < 0.01,
  );
  assert.equal(model.stats.staircaseCount, 0);
  assert.equal(model.dimensions.heightMm, 3);
  assert.ok(
    model.warnings.some((warning) =>
      warning.includes("relier des marches imprimables au terrain"),
    ),
  );
});

/** Independent vertical ray through a closed boundary; duplicate shared edges
 * are welded before counting intervals of material. */
function verticalCrossings(mesh: PrintMesh, x: number, y: number) {
  const crossings: number[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.slice(i, i + 3), (index) =>
      Array.from(mesh.positions.slice(index * 3, index * 3 + 3)),
    );
    const denominator =
      (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-10) continue;
    const u =
      ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
    const v =
      ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
      crossings.push(u * a[2] + v * b[2] + (1 - u - v) * c[2]);
  }
  return [...new Set(crossings.map((z) => Number(z.toFixed(4))))].sort(
    (a, b) => a - b,
  );
}

test("documented bridges cut an actual underpass through the terrain in the final exported solid", async () => {
  const bridge = feature(
    8,
    {
      man_made: "bridge",
      name: "Measured test bridge",
      "printmap:bridge_span": "14",
      "printmap:bridge_clearance": "4",
      "printmap:bridge_profile": "Voute en anse de panier (Pont)",
      "printmap:bridge_deck_elevation": "6",
      "printmap:bridge_deck_uncertainty": "1.5",
    },
    [
      [-10, -8],
      [10, -8],
      [10, 8],
      [-10, 8],
    ],
  );
  const carriedRoad = feature(
    9,
    { highway: "residential", bridge: "yes" },
    [
      [-10, 0],
      [10, 0],
    ],
    false,
  );
  const data = input([
    bridge,
    carriedRoad,
    feature(
      10,
      {
        highway: "residential",
        name: "Lower street",
        tunnel: "yes",
        layer: "-1",
      },
      [
        [0, -8],
        [0, 8],
      ],
      false,
    ),
    feature(
      11,
      { highway: "residential", name: "Lower street" },
      [
        [0, -54],
        [0, -8],
      ],
      false,
    ),
    feature(
      12,
      { highway: "residential", name: "Lower street" },
      [
        [0, 8],
        [0, 54],
      ],
      false,
    ),
  ]);
  data.elevationGrid = {
    rows: 9,
    cols: 9,
    points: Array.from({ length: 81 }, (_, index) => (index === 40 ? 8 : 0)),
    minElev: 0,
    maxElev: 8,
    south: 0,
    west: 0,
    north: 0.001,
    east: 0.001,
    resolutionM: 13.9,
  };
  const model = await buildPrintModel(data);
  assertClosedSolid(model);
  assert.equal(model.stats.reconstructedBridgeCount, 1);
  assert.equal(model.stats.pierCount, 0, "a bridge is not an embossed pier");
  const levels = verticalCrossings(model, 0, 1.13);
  assert.deepEqual(
    levels,
    [0, 3, 7, 9],
    "socle, passage floor, arch soffit and deck are distinct; terrain no longer fills the vault",
  );
  assert.ok(
    model.warnings.some((warning) =>
      warning.includes("Courbure elliptique approchée"),
    ),
  );
  const unknown = structuredClone(data);
  delete unknown.osmData.elements[0].tags!["printmap:bridge_span"];
  const fallback = await buildPrintModel(unknown);
  assertClosedSolid(fallback);
  assert.equal(fallback.stats.reconstructedBridgeCount, 0);
  assert.equal(
    verticalCrossings(fallback, 0, 1.13).length,
    2,
    "unknown bridge retains the terrain, no imagined vault",
  );
  assert.ok(
    fallback.warnings.some((warning) =>
      warning.includes("ne fournissent pas de voûtes"),
    ),
  );
});

test("the actual Peyrou plaza colours a terrace with holes without changing its relief or filling the basin", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/montpellier-peyrou-plaza.json", import.meta.url),
      "utf8",
    ),
  ) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  settings.features.buildings.enabled = false;
  settings.features.parks.enabled = false;
  settings.features.sand.enabled = false;
  settings.features.piers.enabled = false;
  settings.features.roads.filter = "all";
  settings.features.roads.roadTypeEnabled.steps = false;
  settings.features.water.waterDepthMm = 0.4;
  const baselineSettings = structuredClone(settings);
  baselineSettings.features.roads.enabled = false;
  const baseline = await buildPrintModel({
      ...fixture,
      settings: baselineSettings,
    }),
    model = await buildPrintModel({ ...fixture, settings });
  const baselineVolume = assertClosedSolid(baseline),
    volume = assertClosedSolid(model);
  assert.ok(
    Math.abs(volume - baselineVolume) / baselineVolume < 1e-6,
    "colour partition does not add a skin or restore removed material",
  );
  assert.ok(
    model.warnings.some((warning) =>
      warning.includes("Terrasse des eaux du Peyrou"),
    ),
    "the actual mapped terrace correction is active",
  );
  assert.equal(model.stats.roadCount, 1);
  assert.equal(model.stats.staircaseCount, 0);
  assert.ok(upwardVertices(model, "roads").length > 0);
  const projection = createProjectionForBbox(fixture.bbox),
    sf = 1000 / fixture.scale;
  const basin = fixture.osmData.elements.find((e) => e.id === 236815262)!;
  const pts = basin
    .geometry!.slice(0, -1)
    .map((p) => projection.project(p.lon, p.lat).map((v) => v * sf));
  const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length,
    y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  assert.deepEqual(
    verticalCrossings(model, x, y),
    verticalCrossings(baseline, x, y),
    "the real multipolygon hole preserves the excavated basin",
  );
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(
    Math.abs(tileVolume - volume) / volume < 1e-4,
    "all four terrace tiles remain closed and conserve volume",
  );
});

test("engraving the actual Peyrou plaza removes its requested depth and preserves an existing basin cavity", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/montpellier-peyrou-plaza.json", import.meta.url),
      "utf8",
    ),
  ) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  settings.features.buildings.enabled = false;
  settings.features.parks.enabled = false;
  settings.features.sand.enabled = false;
  settings.features.piers.enabled = false;
  settings.features.roads.filter = "all";
  settings.features.roads.roadTypeEnabled.steps = false;
  settings.features.water.waterDepthMm = 0.4;
  const baseline = await buildPrintModel({ ...fixture, settings });
  const engravedSettings = structuredClone(settings);
  engravedSettings.features.roads.heightMm = -0.2;
  const model = await buildPrintModel({
    ...fixture,
    settings: engravedSettings,
  });
  const baselineVolume = assertClosedSolid(baseline),
    volume = assertClosedSolid(model);
  let roadArea = 0;
  for (let at = 0; at < baseline.indices.length; at += 3) {
    if (PRINT_LAYERS[baseline.faceLayers[at / 3]] !== "roads") continue;
    const [a, b, c] = Array.from(
      baseline.indices.subarray(at, at + 3),
      (index) =>
        Array.from(baseline.positions.subarray(index * 3, index * 3 + 3)),
    );
    const normalZ =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (normalZ > 0) roadArea += normalZ / 2;
  }
  const expectedRemoval = roadArea * 0.2;
  assert.ok(expectedRemoval > 600, "the mapped plaza has a substantial area");
  // The cutter stays 0.02 mm inside the source outline; the colour at zero
  // offset stays 0.005 mm inside it. This tiny perimeter difference accounts
  // for less than one percent of the independent area × depth prediction.
  assert.ok(
    Math.abs(baselineVolume - volume - expectedRemoval) / expectedRemoval <
      0.01,
    "engraving subtracts the area times the requested depth, without replacing lower material",
  );
  const interior: [number, number] = [-1.6004835765, 16.1500813166];
  const initialLevels = verticalCrossings(baseline, ...interior),
    engravedLevels = verticalCrossings(model, ...interior);
  assert.equal(initialLevels.length, 2);
  assert.equal(engravedLevels.length, 2);
  assert.equal(
    engravedLevels[0],
    initialLevels[0],
    "the bedplate is preserved",
  );
  assert.ok(
    Math.abs(initialLevels[1] - engravedLevels[1] - 0.2) < 0.0002,
    "the visible road surface is engraved by 0.2 mm",
  );
  const projection = createProjectionForBbox(fixture.bbox),
    sf = 1000 / fixture.scale;
  const basin = fixture.osmData.elements.find(
    (element) => element.id === 236815262,
  )!;
  const ring = basin
    .geometry!.slice(0, -1)
    .map((point) =>
      projection.project(point.lon, point.lat).map((value) => value * sf),
    );
  const x = ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
    y = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  assert.deepEqual(
    verticalCrossings(model, x, y),
    verticalCrossings(baseline, x, y),
    "deep colour partition keeps the plaza hole and does not fill the previously cut basin",
  );
  assert.ok(upwardVertices(model, "roads").length > 0);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.equal(model.tiles.length, 4);
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
});
