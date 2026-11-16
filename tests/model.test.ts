import test from "node:test";
import assert from "node:assert/strict";
import type { ElevationGrid, MapData, OverpassElement } from "@/types/osm";
import { buildModel, type MeshData } from "@/lib/model/build";
import { meshDefect } from "@/lib/model/check";
import {
  BED_MARGIN_MM,
  computeLayout,
  DEFAULT_SETTINGS,
  type ModelSettings,
} from "@/lib/model/settings";
import { exportModel, stlBytes } from "@/lib/export/files";
import { roofFromTags } from "@/lib/osm/building-height";
import { orientedBox } from "@/lib/model/roofs";

// About 500 m × 400 m near Montpellier.
const SOUTH = 43.6,
  WEST = 3.87,
  NORTH = 43.6036,
  EAST = 3.8762;
const at = (x: number, y: number) => ({
  lon: WEST + x * (EAST - WEST),
  lat: SOUTH + y * (NORTH - SOUTH),
});
const box = (x0: number, y0: number, x1: number, y1: number) => [
  at(x0, y0),
  at(x1, y0),
  at(x1, y1),
  at(x0, y1),
  at(x0, y0),
];
let nextId = 1;
const way = (
  tags: Record<string, string>,
  geometry: ReturnType<typeof box>,
): OverpassElement => ({ type: "way", id: nextId++, tags, geometry });

function sampleData(relief: boolean): MapData {
  const elements: OverpassElement[] = [
    way({ building: "yes", height: "12" }, box(0.1, 0.1, 0.25, 0.3)),
    // Shares a wall with the first one, and straddles the 2 × 2 seams.
    way(
      { building: "apartments", "building:levels": "4" },
      box(0.25, 0.1, 0.55, 0.3),
    ),
    way({ building: "yes" }, box(0.45, 0.45, 0.6, 0.6)),
    // Courtyard building as a multipolygon.
    {
      type: "relation",
      id: nextId++,
      tags: { type: "multipolygon", building: "yes", height: "20" },
      members: [
        { type: "way", role: "outer", geometry: box(0.65, 0.6, 0.9, 0.9) },
        { type: "way", role: "inner", geometry: box(0.72, 0.68, 0.83, 0.82) },
      ],
    },
    // Partly outside the selection: must be clipped at the border.
    way({ building: "yes", height: "9" }, box(0.9, 0.05, 1.2, 0.2)),
    way({ highway: "primary" }, [at(-0.1, 0.4), at(0.5, 0.42), at(1.1, 0.38)]),
    way({ highway: "residential" }, [
      at(0.6, -0.1),
      at(0.62, 0.5),
      at(0.6, 1.1),
    ]),
    way({ highway: "residential", tunnel: "yes" }, [at(0, 0.9), at(1, 0.9)]),
    way({ natural: "water" }, box(0.05, 0.55, 0.35, 0.95)),
    way({ waterway: "stream" }, [at(0.35, 0.75), at(0.6, 0.72)]),
    way({ leisure: "park" }, box(0.3, 0.5, 0.58, 0.98)),
  ];
  const rows = 9,
    cols = 9,
    points: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) points.push(40 + c * 2.5 + Math.sin(r) * 6);
  const elevation: ElevationGrid = {
    rows,
    cols,
    points,
    minElev: Math.min(...points),
    maxElev: Math.max(...points),
    south: SOUTH,
    west: WEST,
    north: NORTH,
    east: EAST,
  };
  return {
    bbox: [SOUTH, WEST, NORTH, EAST],
    elements,
    elevation: relief ? elevation : null,
    sources: [],
    warnings: [],
    fetchedAt: "2026-01-01T00:00:00Z",
    detailed: true,
  };
}

function assertWatertight(mesh: MeshData, name: string) {
  assert.equal(meshDefect(mesh), null, name);
}
function bounds(mesh: MeshData) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}
const settings = (patch: Partial<ModelSettings>): ModelSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

test("single plate: closed solid resting on the bed, within the printer", async () => {
  const model = await buildModel({
    data: sampleData(false),
    settings: settings({ bedWidthMm: 220, bedDepthMm: 220 }),
  });
  assert.equal(model.tiles.length, 1);
  const [tile] = model.tiles;
  assertWatertight(tile.solid, "solid");
  for (const part of tile.parts) assertWatertight(part, part.layer);
  assert.deepEqual(
    tile.parts.map((part) => part.layer),
    ["base", "roads", "water", "green", "buildings"],
  );
  const { min, max } = bounds(tile.solid);
  assert.ok(Math.abs(min[2]) < 1e-4, "bottom at Z = 0");
  assert.ok(min[0] > -1e-3 && min[1] > -1e-3);
  assert.ok(max[0] <= 210 + 1e-3 && max[1] <= 210 + 1e-3);
  // 500 m wide on 210 mm: the 20 m courtyard building is 8.4 mm tall.
  assert.ok(Math.abs(max[2] - (3 + 20 * model.layout.mmPerM)) < 0.11);
  assert.equal(model.stats.buildings, 5);
  assert.equal(model.keys, null);
});

for (const relief of [false, true])
  test(`2 × 2 plates${relief ? " with relief" : ""}: closed, equal, volume preserved`, async () => {
    const data = sampleData(relief);
    const whole = await buildModel({
      data,
      settings: settings({
        relief,
        sizeMode: "custom",
        longSideMm: 300,
        bedWidthMm: 400,
        bedDepthMm: 400,
      }),
    });
    const cut = await buildModel({
      data,
      settings: settings({
        relief,
        sizeMode: "custom",
        longSideMm: 300,
        bedWidthMm: 160,
        bedDepthMm: 160,
        labels: false,
        connectors: false,
      }),
    });
    assert.equal(whole.tiles.length, 1);
    assert.equal(cut.tiles.length, 4);
    assert.equal(cut.stats.relief, relief);
    let volume = 0;
    for (const tile of cut.tiles) {
      assertWatertight(tile.solid, `plate ${tile.label}`);
      for (const part of tile.parts)
        assertWatertight(part, `plate ${tile.label} ${part.layer}`);
      const { min, max } = bounds(tile.solid);
      assert.ok(Math.abs(min[2]) < 1e-4);
      assert.ok(min[0] > -1e-3 && max[0] < tile.widthMm + 1e-3);
      assert.ok(min[1] > -1e-3 && max[1] < tile.depthMm + 1e-3);
      assert.ok(tile.widthMm <= 150 && tile.depthMm <= 150);
      volume += tile.volumeMm3;
    }
    const expected = whole.tiles[0].volumeMm3;
    assert.ok(
      Math.abs(volume - expected) / expected < 1e-4,
      `plates ${volume} vs whole ${expected}`,
    );
    assert.deepEqual(
      cut.tiles.map((tile) => tile.label),
      ["1-1", "2-1", "1-2", "2-2"],
    );
    // Row 1 is the northern one.
    assert.ok(cut.tiles[0].y0 > cut.tiles[2].y0);
  });

test("keys and labels remove material under the plates only", async () => {
  const data = sampleData(false);
  const grid = { cols: 2, rows: 2, bedWidthMm: 160, bedDepthMm: 160 };
  const plain = await buildModel({
    data,
    settings: settings({ ...grid, labels: false, connectors: false }),
  });
  const keyed = await buildModel({ data, settings: settings(grid) });
  assert.ok(keyed.keys);
  // Four seam segments over 100 mm long, two keys each, plus two spares.
  assert.equal(keyed.keys.count, 10);
  assertWatertight(keyed.keys, "keys");
  keyed.tiles.forEach((tile, index) => {
    assertWatertight(tile.solid, `plate ${tile.label}`);
    assert.ok(tile.volumeMm3 < plain.tiles[index].volumeMm3);
    assert.equal(tile.heightMm, plain.tiles[index].heightMm);
  });
});

test("layers can be switched off and an empty zone still prints", async () => {
  const data = sampleData(false);
  const bare = await buildModel({
    data,
    settings: settings({
      buildings: false,
      roads: false,
      water: false,
      green: false,
    }),
  });
  assert.deepEqual(
    bare.tiles[0].parts.map((part) => part.layer),
    ["base"],
  );
  assert.ok(Math.abs(bare.tiles[0].heightMm - DEFAULT_SETTINGS.baseMm) < 1e-4);
  const empty = await buildModel({
    data: { ...data, elements: [] },
    settings: settings({}),
  });
  assertWatertight(empty.tiles[0].solid, "empty zone");
});

test("layout: grid fills the plates, custom size computes the grid", () => {
  const fill = computeLayout(
    1000,
    500,
    settings({ cols: 2, rows: 1, bedWidthMm: 220, bedDepthMm: 220 }),
  );
  assert.equal(fill.widthMm, 420);
  assert.equal(fill.depthMm, 210);
  assert.equal(fill.tileWidthMm, 210);
  assert.equal(Math.round(fill.scale), 2381);
  const custom = computeLayout(
    1000,
    500,
    settings({
      sizeMode: "custom",
      longSideMm: 500,
      bedWidthMm: 220,
      bedDepthMm: 220,
    }),
  );
  assert.deepEqual([custom.cols, custom.rows], [3, 2]);
  assert.ok(custom.tileWidthMm <= 220 - 2 * BED_MARGIN_MM);
  // A rectangular bed is turned when that needs fewer plates.
  const turned = computeLayout(
    500,
    1000,
    settings({
      sizeMode: "custom",
      longSideMm: 240,
      bedWidthMm: 250,
      bedDepthMm: 150,
    }),
  );
  assert.deepEqual([turned.cols, turned.rows], [1, 1]);
});

test("exports: STL size matches its triangles, several plates give a ZIP", async () => {
  const data = sampleData(false);
  const one = await buildModel({ data, settings: settings({}) });
  const stl = stlBytes(one.tiles[0].solid);
  assert.equal(stl.length, 84 + (one.tiles[0].solid.indices.length / 3) * 50);
  const single = await exportModel(one, DEFAULT_SETTINGS, "3mf", "ville");
  assert.equal(single.filename, "ville.3mf");
  assert.equal(String.fromCharCode(single.bytes[0], single.bytes[1]), "PK");
  const four = await buildModel({
    data,
    settings: settings({ cols: 2, rows: 2 }),
  });
  const zip = await exportModel(four, DEFAULT_SETTINGS, "stl", "ville");
  assert.equal(zip.filename, "ville-2x2-stl.zip");
});

// ── Roofs ────────────────────────────────────────────────────────────────
function roofData(elements: OverpassElement[]): MapData {
  return { ...sampleData(false), elements };
}
/** 60 m × 40 m, long side east-west. */
const hall = (tags: Record<string, string>) =>
  way({ building: "yes", height: "15", ...tags }, box(0.1, 0.1, 0.22, 0.2));
const roofSettings = settings({ roads: false, water: false, green: false });

test("roof tags: shapes, heights and directions", () => {
  assert.equal(roofFromTags({ "roof:shape": "flat" }), null);
  assert.equal(roofFromTags({ building: "yes" }), null);
  assert.deepEqual(
    roofFromTags({ "roof:shape": "gabled", "roof:height": "3,5" }),
    {
      shape: "gabled",
      heightM: 3.5,
      direction: null,
      across: false,
    },
  );
  const mansard = roofFromTags({
    "roof:shape": "mansard",
    "roof:levels": "2",
    "roof:direction": "NE",
    "roof:orientation": "across",
  });
  assert.deepEqual(mansard, {
    shape: "hipped",
    heightM: 6,
    direction: 45,
    across: true,
  });
  assert.equal(
    roofFromTags({ "roof:shape": "dome", "roof:direction": "270" })?.direction,
    270,
  );
});

test("oriented box follows a rotated footprint", () => {
  // 10 × 4 rectangle turned by 30°.
  const c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6);
  const ring = [
    [-5, -2],
    [5, -2],
    [5, 2],
    [-5, 2],
  ].map(([x, y]) => [x * c - y * s + 7, x * s + y * c + 3] as [number, number]);
  const found = orientedBox(ring);
  assert.ok(Math.abs(found.a - 5) < 1e-9 && Math.abs(found.b - 2) < 1e-9);
  assert.ok(Math.abs(found.cx - 7) < 1e-9 && Math.abs(found.cy - 3) < 1e-9);
  assert.ok(Math.abs(Math.abs(found.ux * c + found.uy * s) - 1) < 1e-9);
});

test("gabled roof: closed, as tall as tagged, and lighter than a block", async () => {
  const elements = [hall({ "roof:shape": "gabled", "roof:height": "5" })];
  const roofed = await buildModel({
    data: roofData(elements),
    settings: roofSettings,
  });
  const block = await buildModel({
    data: roofData(elements),
    settings: { ...roofSettings, roofs: false },
  });
  const k = roofed.layout.mmPerM;
  assert.equal(roofed.stats.roofs, 1);
  assert.equal(block.stats.roofs, 0);
  assertWatertight(roofed.tiles[0].solid, "gabled");
  for (const part of roofed.tiles[0].parts) assertWatertight(part, part.layer);
  // OSM height reaches the ridge: 10 m of wall and 5 m of roof.
  assert.ok(Math.abs(roofed.heightMm - (3 + 15 * k)) < 0.11);
  assert.ok(Math.abs(block.heightMm - (3 + 15 * k)) < 0.11);
  // A gable removes half of the roof's bounding volume.
  const removed = block.tiles[0].volumeMm3 - roofed.tiles[0].volumeMm3;
  const half = (60 * k * 40 * k * 5 * k) / 2;
  assert.ok(Math.abs(removed - half) < 0.12 * half, `${removed} vs ${half}`);
});

test("every roof shape gives a closed solid on any footprint", async () => {
  const circle = (cx: number, cy: number, r: number) => {
    const ring = Array.from({ length: 16 }, (_, i) =>
      at(
        cx + r * Math.cos((i / 16) * 2 * Math.PI),
        cy + r * 1.25 * Math.sin((i / 16) * 2 * Math.PI),
      ),
    );
    return [...ring, ring[0]];
  };
  const lShape = [
    at(0.5, 0.5),
    at(0.7, 0.5),
    at(0.7, 0.6),
    at(0.6, 0.6),
    at(0.6, 0.8),
    at(0.5, 0.8),
    at(0.5, 0.5),
  ];
  for (const shape of [
    "gabled",
    "hipped",
    "pyramidal",
    "skillion",
    "dome",
    "cone",
    "gambrel",
    "onion",
  ]) {
    const elements = [
      hall({ "roof:shape": shape, "roof:height": "6" }),
      way({ building: "yes", height: "14", "roof:shape": shape }, lShape),
      way(
        { building: "yes", height: "20", "roof:shape": shape },
        circle(0.35, 0.6, 0.05),
      ),
      // Cut by the edge of the model.
      way(
        { building: "yes", height: "12", "roof:shape": shape },
        box(0.9, 0.3, 1.1, 0.45),
      ),
      // Courtyard.
      {
        type: "relation" as const,
        id: nextId++,
        tags: {
          type: "multipolygon",
          building: "yes",
          height: "16",
          "roof:shape": shape,
        },
        members: [
          { type: "way", role: "outer", geometry: box(0.1, 0.5, 0.3, 0.9) },
          { type: "way", role: "inner", geometry: box(0.15, 0.6, 0.25, 0.8) },
        ],
      },
    ];
    for (const relief of [false, true]) {
      const model = await buildModel({
        data: { ...roofData(elements), elevation: sampleData(true).elevation },
        settings: { ...roofSettings, relief, cols: 2, rows: 2 },
      });
      assert.equal(model.stats.roofs, 5, shape);
      for (const tile of model.tiles) {
        assertWatertight(tile.solid, `${shape} ${tile.label}`);
        for (const part of tile.parts)
          assertWatertight(part, `${shape} ${tile.label} ${part.layer}`);
      }
    }
  }
});

test("a single-pitch roof rises away from the way it faces", async () => {
  // Faces south: the high edge is the northern one.
  const model = await buildModel({
    data: roofData([
      hall({
        "roof:shape": "skillion",
        "roof:height": "5",
        "roof:direction": "180",
      }),
    ]),
    settings: roofSettings,
  });
  const { positions } = model.tiles[0].solid;
  const north = 0.2 * model.layout.depthMm,
    south = 0.1 * model.layout.depthMm;
  let ridge = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < model.heightMm - 1e-3) continue;
    ridge++;
    assert.ok(
      Math.abs(positions[i + 1] - north) < 0.05,
      "high edge on the north side",
    );
    assert.ok(Math.abs(positions[i + 1] - south) > 1);
  }
  assert.ok(ridge >= 2);
});

test("a measured gutter height keeps the walls and adds the roof on top", async () => {
  const model = await buildModel({
    data: roofData([
      hall({
        "roof:shape": "hipped",
        "roof:height": "4",
        height: "16",
        "printmap:eave_height": "12",
      }),
    ]),
    settings: roofSettings,
  });
  assert.ok(Math.abs(model.heightMm - (3 + 16 * model.layout.mmPerM)) < 0.11);
});
