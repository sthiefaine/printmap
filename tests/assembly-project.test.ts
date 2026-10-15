import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { createLocalProjection } from "../src/lib/projection";
import {
  createAssemblyProject,
  validateAssemblyProject,
  assemblyCellBbox,
  assemblyBounds,
  addAssemblyNeighbor,
  alignAssemblyElevation,
  validateAssemblyData,
  cellKey,
  cellLabel,
  ASSEMBLY_TERRAIN_SEGMENTS,
  type AssemblyProject,
} from "../src/lib/assembly-project";
import { readAssemblyCell, listAssemblyCells } from "../src/lib/assembly-cache";
import type { BBox, ElevationGrid, MapDataResponse } from "../src/types/osm";

const origin = { lat: 43.6099, lng: 3.8677 };
function selection(widthM = 700, heightM = 700): BBox {
  const [east, north] = createLocalProjection(origin.lat, origin.lng).unproject(
    widthM,
    heightM,
  );
  return [origin.lat, origin.lng, north, east];
}
function project(widthM = 700, heightM = 700, scale = 5000) {
  return createAssemblyProject(
    selection(widthM, heightM),
    scale,
    DEFAULT_MODEL_SETTINGS,
    "Montpellier extensible",
  );
}
function elevation(bbox: BBox, offset = 0, rows = 5, cols = 7): ElevationGrid {
  const projection = createLocalProjection(origin.lat, origin.lng);
  const points = Array.from({ length: rows * cols }, (_, i) => {
    const lat =
      bbox[0] + ((bbox[2] - bbox[0]) * Math.floor(i / cols)) / (rows - 1);
    const lng = bbox[1] + ((bbox[3] - bbox[1]) * (i % cols)) / (cols - 1);
    const [x, y] = projection.project(lng, lat);
    return 55 + x * 0.01 + y * 0.02 + offset;
  });
  return {
    rows,
    cols,
    points,
    south: bbox[0],
    west: bbox[1],
    north: bbox[2],
    east: bbox[3],
    minElev: Math.min(...points),
    maxElev: Math.max(...points),
    source: "Test DEM plane",
    resolutionM: 2,
  };
}
function data(bbox: BBox): MapDataResponse {
  return {
    osmData: {
      elements: [
        {
          type: "way",
          id: 1,
          tags: { building: "yes" },
          geometry: [
            { lat: bbox[0], lon: bbox[1] },
            { lat: bbox[2], lon: bbox[1] },
            { lat: bbox[2], lon: bbox[3] },
            { lat: bbox[0], lon: bbox[1] },
          ],
        },
      ],
    },
    elevationGrid: elevation(bbox),
    report: {
      sources: ["Test source"],
      warnings: [],
      fetchedAt: "2026-10-15T10:00:00.000Z",
      areaKm2: 0.525625,
      elementCount: 1,
      buildingCount: 1,
      measuredBuildingCount: 0,
      ignBuildingCount: 0,
      elevationSource: "Test DEM plane",
      elevationResolutionM: 2,
      seaCoverage: "unavailable",
    },
  };
}

test("a southwest-anchored square lattice covers the selection without a roundoff tile", () => {
  const p = project(725 * 2, 725 * 3);
  assert.equal(p.cells.length, 6);
  assert.deepEqual(p.cells, [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 0, row: 1 },
    { col: 1, row: 1 },
    { col: 0, row: 2 },
    { col: 1, row: 2 },
  ]);
  assert.deepEqual(p.origin, origin);
  assert.deepEqual(p.activeCell, { col: 0, row: 0 });
  assert.equal(p.terrainStepM, 725 / 64);
  assert.equal(p.elevationDatumM, null);
  assert.deepEqual(p.boundaryElevations, {});
  const bounds = assemblyBounds(p),
    selected = selection(1450, 2175);
  bounds.forEach((n, i) => assert.ok(Math.abs(n - selected[i]) < 1e-12));
  const projection = createLocalProjection(origin.lat, origin.lng);
  for (const cell of p.cells) {
    const b = assemblyCellBbox(p, cell),
      [x, y] = projection.project(b[3], b[2]);
    assert.ok(Math.abs(x - (cell.col + 1) * 725) < 1e-7);
    assert.ok(Math.abs(y - (cell.row + 1) * 725) < 1e-7);
  }
});

test("creation snapshots settings and removes the inter-plate frame without mutating inputs", () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.frame.enabled = settings.base.frame.textEnabled = true;
  settings.base.grid = { cols: 3, rows: 2 };
  const before = structuredClone(settings),
    p = createAssemblyProject(selection(), 5000, settings, "Test");
  assert.deepEqual(settings, before);
  assert.deepEqual(p.settings.base.grid, { cols: 1, rows: 1 });
  assert.equal(p.settings.base.plateSizeMm, 150);
  assert.equal(p.settings.base.frame.enabled, false);
  assert.equal(p.settings.base.frame.textEnabled, false);
  p.settings.features.water.color = "#123456";
  assert.equal(settings.features.water.color, before.features.water.color);
});

test("signed neighbors share exact geographic borders and do not move existing cells", () => {
  const p = project(),
    initial = assemblyCellBbox(p, { col: 0, row: 0 });
  const west = addAssemblyNeighbor(p, { col: 0, row: 0 }, "west");
  const southwest = addAssemblyNeighbor(west, { col: -1, row: 0 }, "south");
  assert.deepEqual(p.cells, [{ col: 0, row: 0 }]);
  assert.deepEqual(assemblyCellBbox(southwest, { col: 0, row: 0 }), initial);
  const w = assemblyCellBbox(southwest, { col: -1, row: 0 }),
    sw = assemblyCellBbox(southwest, { col: -1, row: -1 });
  assert.equal(w[3], initial[1]);
  assert.equal(sw[2], w[0]);
  assert.equal(cellKey(southwest.activeCell!), "-1,-1");
  assert.equal(cellLabel(southwest.activeCell!), "C-1 · L-1");
});

test("adding an existing neighbor activates it without duplicating a cell", () => {
  const p = project(1400, 700);
  const next = addAssemblyNeighbor(p, { col: 1, row: 0 }, "west");
  assert.equal(next.cells.length, 2);
  assert.deepEqual(next.activeCell, { col: 0, row: 0 });
});

test("project roundtrip preserves fixed source metadata and rejects disconnected or corrupt plans", () => {
  const p = project();
  p.elevationDatumM = -2;
  p.boundaryElevations["0,0"] = 54;
  assert.deepEqual(validateAssemblyProject(JSON.parse(JSON.stringify(p))), p);
  const invalid: Array<(copy: AssemblyProject) => void> = [
    (p) => {
      p.scale = NaN;
    },
    (p) => {
      p.terrainStepM *= 2;
    },
    (p) => {
      p.cells.push({ col: 2, row: 0 });
    },
    (p) => {
      p.cells.push({ col: 0, row: 0 });
    },
    (p) => {
      p.activeCell = { col: 1, row: 0 };
    },
    (p) => {
      p.cells[0].col = 0.5;
    },
    (p) => {
      p.origin.lng = 181;
    },
    (p) => {
      p.boundaryElevations["1,1"] = 50;
    },
    (p) => {
      p.boundaryElevations["0,0"] = NaN;
    },
    (p) => {
      p.settings.base.frame.enabled = true;
    },
    (p) => {
      p.settings.base.frame.textEnabled = true;
    },
    (p) => {
      p.settings.base.grid.cols = 2;
    },
    (p) => {
      p.settings.base.plateSizeMm = 100;
    },
    (p) => {
      p.settings.features.roads.roadTypeEnabled = null as never;
    },
    (p) => {
      p.settings.print.minFeatureMm = -0.1;
    },
    (p) => {
      p.id = "../invalid";
    },
  ];
  for (const mutate of invalid) {
    const copy = structuredClone(p);
    mutate(copy);
    assert.throws(() => validateAssemblyProject(copy));
  }
});

test("100-cell and 48-km limits fail before expanding an unsafe plan", () => {
  assert.throws(() => project(290 * 11, 290 * 10, 2000), /100 plaques/);
  const p = project(30, 30, 200);
  p.cells = Array.from({ length: 100 }, (_, col) => ({ col, row: 0 }));
  assert.equal(validateAssemblyProject(p).cells.length, 100);
  assert.throws(
    () => addAssemblyNeighbor(p, { col: 99, row: 0 }, "east"),
    /100 plaques/,
  );
  const large = project(4000, 4000, 34000);
  large.cells = Array.from({ length: 10 }, (_, col) => ({ col, row: 0 }));
  assert.throws(() => validateAssemblyProject(large), /48 km/);
  assert.throws(() => project(700, 700, 199));
  assert.throws(() => project(700, 700, 34001));
});

test("unrepresentable polar or dateline cells are rejected instead of wrapping the grid", () => {
  const p = project();
  p.origin.lng = 179.999;
  assert.throws(() => validateAssemblyProject(p), /Zone invalide/);
  const nearPole = project();
  nearPole.origin.lat = 84.9999;
  assert.throws(() => validateAssemblyProject(nearPole), /Zone invalide/);
});

test("alignment samples a plane on the fixed 65-by-65 global lattice with honest spacing", () => {
  const p = project(),
    bbox = assemblyCellBbox(p, { col: 0, row: 0 }),
    source = elevation(bbox);
  const sourceBefore = structuredClone(source),
    aligned = alignAssemblyElevation(p, { col: 0, row: 0 }, source);
  assert.equal(aligned.grid.rows, 65);
  assert.equal(aligned.grid.cols, 65);
  assert.equal(aligned.grid.resolutionM, 725 / 64);
  assert.equal(Object.keys(aligned.boundaryElevations).length, 256);
  assert.deepEqual(p.boundaryElevations, {});
  assert.deepEqual(source, sourceBefore);
  const step = p.terrainStepM;
  for (const [c, r] of [
    [0, 0],
    [32, 13],
    [64, 64],
  ])
    assert.ok(
      Math.abs(
        aligned.grid.points[r * 65 + c] -
          (55 + c * step * 0.01 + r * step * 0.02),
      ) < 1e-8,
    );
  assert.equal(aligned.grid.minElev, Math.min(...aligned.grid.points));
  assert.equal(aligned.grid.maxElev, Math.max(...aligned.grid.points));
});

test("adjacent providers with different samples and offsets reuse every prepared border and corner", () => {
  let p = addAssemblyNeighbor(project(), { col: 0, row: 0 }, "east");
  p = addAssemblyNeighbor(p, { col: 0, row: 0 }, "north");
  p = addAssemblyNeighbor(p, { col: 1, row: 0 }, "north");
  const southwest = alignAssemblyElevation(
    p,
    { col: 0, row: 0 },
    elevation(assemblyCellBbox(p, { col: 0, row: 0 })),
  );
  p = { ...p, boundaryElevations: southwest.boundaryElevations };
  const southeast = alignAssemblyElevation(
    p,
    { col: 1, row: 0 },
    elevation(assemblyCellBbox(p, { col: 1, row: 0 }), 4, 8, 3),
  );
  p = { ...p, boundaryElevations: southeast.boundaryElevations };
  const northwest = alignAssemblyElevation(
    p,
    { col: 0, row: 1 },
    elevation(assemblyCellBbox(p, { col: 0, row: 1 }), -2, 3, 9),
  );
  p = { ...p, boundaryElevations: northwest.boundaryElevations };
  const northeast = alignAssemblyElevation(
    p,
    { col: 1, row: 1 },
    elevation(assemblyCellBbox(p, { col: 1, row: 1 }), 20),
  );
  for (let n = 0; n <= ASSEMBLY_TERRAIN_SEGMENTS; n++) {
    assert.equal(
      southwest.grid.points[n * 65 + 64],
      southeast.grid.points[n * 65],
    );
    assert.equal(southwest.grid.points[64 * 65 + n], northwest.grid.points[n]);
    assert.equal(southeast.grid.points[64 * 65 + n], northeast.grid.points[n]);
    assert.equal(
      northwest.grid.points[n * 65 + 64],
      northeast.grid.points[n * 65],
    );
  }
  assert.equal(southwest.grid.points.at(-1), northeast.grid.points[0]);
  assert.ok(
    northeast.grid.warnings?.some((w) => w.includes("bords déjà préparés")),
  );
  assert.ok(northeast.grid.points[32 * 65 + 32] > southeast.grid.maxElev);
});

test("negative-index boundaries also match after save/reload and repeated regridding", () => {
  let p = addAssemblyNeighbor(project(), { col: 0, row: 0 }, "west");
  const westCell = { col: -1, row: 0 },
    first = alignAssemblyElevation(
      p,
      westCell,
      elevation(assemblyCellBbox(p, westCell), 5),
    );
  p = validateAssemblyProject(
    JSON.parse(
      JSON.stringify({ ...p, boundaryElevations: first.boundaryElevations }),
    ),
  );
  const center = alignAssemblyElevation(
    p,
    { col: 0, row: 0 },
    elevation(assemblyCellBbox(p, { col: 0, row: 0 })),
  );
  const again = alignAssemblyElevation(p, westCell, first.grid);
  assert.deepEqual(again.grid.points, first.grid.points);
  for (let r = 0; r < 65; r++)
    assert.equal(first.grid.points[r * 65 + 64], center.grid.points[r * 65]);
});

test("alignment rejects an uncovered crop and never flattens negative elevations to the datum", () => {
  const p = project(),
    cell = { col: 0, row: 0 },
    bbox = assemblyCellBbox(p, cell);
  const crop = elevation(bbox);
  crop.east -= 0.001;
  assert.throws(() => alignAssemblyElevation(p, cell, crop), /ne couvre pas/);
  const below = elevation(bbox, -100);
  p.elevationDatumM = 0;
  const aligned = alignAssemblyElevation(p, cell, below);
  assert.equal(p.elevationDatumM, 0);
  assert.ok(aligned.grid.minElev < 0);
  assert.equal(aligned.grid.points[0], below.points[0]);
});

test("cell imports retain provenance but reject stale relief, malformed coordinates and measured roofs", () => {
  const p = project(),
    bbox = assemblyCellBbox(p, { col: 0, row: 0 }),
    valid = data(bbox);
  assert.deepEqual(validateAssemblyData(valid, bbox), valid);
  const invalid: Array<(copy: MapDataResponse) => void> = [
    (d) => {
      d.elevationGrid!.west += 0.001;
    },
    (d) => {
      d.elevationGrid!.points[0] = NaN;
    },
    (d) => {
      d.osmData.elements[0].geometry![0].lat = NaN;
    },
    (d) => {
      d.report.sources = [42 as never];
    },
    (d) => {
      d.report.fetchedAt = "yesterday";
    },
    (d) => {
      d.report.buildingCount = -1;
    },
    (d) => {
      d.elevationGrid!.resolutionM = -2;
    },
    (d) => {
      d.osmData.elements[0].roofSurfaces = [{ outer: [], holes: [] }];
    },
  ];
  for (const mutate of invalid) {
    const copy = structuredClone(valid);
    mutate(copy);
    assert.throws(() => validateAssemblyData(copy, bbox));
  }
  const noRelief = { ...valid, elevationGrid: null };
  assert.equal(validateAssemblyData(noRelief, bbox).elevationGrid, null);
});

test("cache imports without a browser are safe and fail with a recoverable storage error", async () => {
  if (typeof indexedDB !== "undefined") return;
  await assert.rejects(
    readAssemblyCell("test-project", { col: 0, row: 0 }),
    /stockage local/,
  );
  await assert.rejects(listAssemblyCells("test-project"), /stockage local/);
});
