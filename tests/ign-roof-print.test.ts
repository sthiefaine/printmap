import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import {
  enrichIGNRoofs,
  IGN_ROOF_SOURCE,
  reconstructIGNRoof,
  type IGNRoofGrid,
} from "../src/lib/data/ign-roofs";
import { parseCityJSONBuildings } from "../src/lib/data/cityjson-parser";
import { fromLambert93 } from "../src/lib/data/lambert93";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import {
  PRINT_LAYERS,
  type PrintMesh,
  type PrintModel,
} from "../src/types/print";
import type { BBox, OverpassElement, RoofSurface } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

type Point = [number, number, number];
type Triangle = [Point, Point, Point];
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/saint-etienne-ign-roofs.json", import.meta.url),
    "utf8",
  ),
) as {
  elements: OverpassElement[];
  grid: Omit<IGNRoofGrid, "mns" | "mnt"> & { mns: number[]; mnt: number[] };
};
const raster: IGNRoofGrid = {
  ...fixture.grid,
  mns: Float32Array.from(fixture.grid.mns),
  mnt: Float32Array.from(fixture.grid.mnt),
};
const scales = [9662.45569, 13036.65];
function bboxFor(elements: OverpassElement[]): BBox {
  const points = elements.flatMap(
    (element) =>
      element.geometry ??
      element.members?.flatMap((member) => member.geometry ?? []) ??
      [],
  );
  return [
    Math.min(...points.map((p) => p.lat)) - 0.0002,
    Math.min(...points.map((p) => p.lon)) - 0.0002,
    Math.max(...points.map((p) => p.lat)) + 0.0002,
    Math.max(...points.map((p) => p.lon)) + 0.0002,
  ];
}
const expoBbox = bboxFor(fixture.elements);
function printPoint(
  bbox: BBox,
  scale: number,
  datum: number,
  point: { lon: number; lat: number; elevation: number },
): Point {
  const [x, y] = createProjectionForBbox(bbox).project(point.lon, point.lat);
  return [
    (x * 1000) / scale,
    (y * 1000) / scale,
    DEFAULT_MODEL_SETTINGS.base.basePlateThicknessMm +
      ((point.elevation - datum) * 1000) / scale,
  ];
}
function sourceTriangles(
  surfaces: RoofSurface[],
  bbox: BBox,
  scale: number,
  datum: number,
): Triangle[] {
  return surfaces.flatMap((surface) => {
    const rings = [surface.outer, ...surface.holes].map((ring) =>
      ring.slice(0, -1),
    );
    const points = rings
      .flat()
      .map((point) => printPoint(bbox, scale, datum, point));
    let cursor = rings[0].length;
    const holes = rings.slice(1).map((ring) => {
      const start = cursor;
      cursor += ring.length;
      return start;
    });
    const [ox, oy] = points[0];
    const indices = earcut(
      points.flatMap(([x, y]) => [x - ox, y - oy]),
      holes,
    );
    const result: Triangle[] = [];
    for (let at = 0; at < indices.length; at += 3)
      result.push(
        indices.slice(at, at + 3).map((index) => points[index]) as Triangle,
      );
    return result;
  });
}
const area = ([a, b, c]: Triangle) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
const centroid = (triangle: Triangle, weights = [1 / 3, 1 / 3, 1 / 3]): Point =>
  [0, 1, 2].map((axis) =>
    triangle.reduce((sum, point, at) => sum + point[axis] * weights[at], 0),
  ) as Point;
function top(triangles: Triangle[], x: number, y: number) {
  let z = -Infinity;
  for (const [a, b, c] of triangles) {
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / d;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / d;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      z = Math.max(z, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return z;
}
function upward(mesh: PrintMesh, buildingsOnly = false) {
  const triangles: Triangle[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (buildingsOnly && PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings")
      continue;
    const triangle = Array.from(
      mesh.indices.subarray(at, at + 3),
      (index) =>
        Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)) as Point,
    ) as Triangle;
    const [a, b, c] = triangle;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12)
      triangles.push(triangle);
  }
  return triangles;
}
async function build(
  elements: OverpassElement[],
  bbox: BBox,
  scale: number,
  datum: number,
) {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { rows: 2, cols: 2 };
  return buildPrintModel({
    bbox,
    scale,
    osmData: { elements },
    settings,
    // This flat control uses an actual raster datum, not a synthetic roof. It
    // isolates the native roof envelope from unrelated DEM interpolation error.
    elevationGrid: {
      rows: 2,
      cols: 2,
      points: Array(4).fill(datum),
      minElev: datum,
      maxElev: datum,
      south: bbox[0],
      west: bbox[1],
      north: bbox[2],
      east: bbox[3],
      source:
        "IGN69 datum · controlled flat terrain for native roof print fidelity",
    },
  });
}
function checkClosedAndTiles(model: PrintModel) {
  assert.equal(model.stats.components, 1);
  assert.equal(model.tiles.length, 4);
  const volume = assertClosedSolid(model);
  const tiledVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(
    Math.abs(tiledVolume - volume) / volume < 1e-4,
    "four tiles preserve the whole solid volume",
  );
  return volume;
}
function probe(model: PrintModel, tolerance = 0.01) {
  const whole = upward(model);
  const buildingFaces = upward(model, true);
  const minX = Math.min(
    ...whole.flatMap((triangle) => triangle.map((point) => point[0])),
  );
  const minY = Math.min(
    ...whole.flatMap((triangle) => triangle.map((point) => point[1])),
  );
  const tiles = model.tiles.map((tile) => ({
    tile,
    faces: upward(tile),
    buildings: upward(tile, true),
  }));
  return (point: Point, label: string, empty = false) => {
    const wholeHeight = top(whole, point[0], point[1]);
    assert.ok(
      Math.abs(wholeHeight - point[2]) < tolerance,
      `${label}: visible whole-model height ${wholeHeight}, expected ${point[2]}`,
    );
    if (empty)
      assert.equal(
        top(buildingFaces, point[0], point[1]),
        -Infinity,
        `${label}: no building in the whole model`,
      );
    let count = 0;
    for (const { tile, faces, buildings } of tiles) {
      const x0 = minX + tile.col * tile.widthMm,
        y0 = minY + tile.row * tile.depthMm;
      if (
        point[0] >= x0 &&
        point[0] <= x0 + tile.widthMm &&
        point[1] >= y0 &&
        point[1] <= y0 + tile.depthMm
      ) {
        const x = point[0] - x0 - tile.widthMm / 2,
          y = point[1] - y0 - tile.depthMm / 2;
        assert.ok(
          Math.abs(top(faces, x, y) - point[2]) < tolerance,
          `${label}: tile ${tile.col},${tile.row} height`,
        );
        if (empty)
          assert.equal(
            top(buildings, x, y),
            -Infinity,
            `${label}: no courtyard extrusion in tile`,
          );
        count++;
      }
    }
    assert.ok(count > 0, `${label}: a containing tile was checked`);
  };
}
function enriched(
  element: OverpassElement,
  grid: IGNRoofGrid,
): {
  roof: NonNullable<ReturnType<typeof reconstructIGNRoof>>;
  element: OverpassElement;
} {
  const roof = reconstructIGNRoof(element, grid);
  assert.ok(
    roof,
    `${element.tags?.name ?? element.id}: raster supports reconstruction`,
  );
  return {
    roof,
    element: {
      ...element,
      roofSurfaces: roof.surfaces,
      groundElevation: roof.groundElevation,
      roofSource: IGN_ROOF_SOURCE,
      tags: {
        ...element.tags,
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_resolution_m": String(grid.resolutionM),
        "printmap:roof_fit_tolerance_m": String(0.35 + grid.resolutionM * 0.12),
        height: String(roof.maxElevation - roof.groundElevation),
      },
    },
  };
}

for (const scale of scales)
  for (const id of [63330323, 750956600]) {
    test(`real IGN MNS/MNT Hall ${id === 63330323 ? "B" : "A"} prints its facets and volume at 1:${scale}, including all four tiles`, async (t) => {
      const { element, roof } = enriched(
        fixture.elements.find((element) => element.id === id)!,
        raster,
      );
      const datum = Math.min(...raster.mnt);
      assert.ok(
        roof.groundElevation > 492 && roof.groundElevation < 493,
        "ground remains the actual IGN69 MNT level",
      );
      const model = await build([element], expoBbox, scale, datum);
      assert.equal(
        model.stats.lidarRoofCount,
        1,
        "the actual reconstructed envelope must survive instead of a flat fallback",
      );
      assert.equal(
        model.stats.realRoofCount,
        0,
        "a raster reconstruction is not reported as a measured CityJSON roof",
      );
      const volume = checkClosedAndTiles(model);
      const triangles = sourceTriangles(roof.surfaces, expoBbox, scale, datum);
      const base = DEFAULT_MODEL_SETTINGS.base.basePlateThicknessMm;
      const expectedVolume =
        model.dimensions.widthMm * model.dimensions.depthMm * base +
        triangles.reduce(
          (sum, triangle) =>
            sum + area(triangle) * (centroid(triangle)[2] - base),
          0,
        );
      const fitToleranceM = 0.35 + raster.resolutionM * 0.12;
      const roofArea = triangles.reduce(
        (sum, triangle) => sum + area(triangle),
        0,
      );
      // Unlike CRAIG/CityGML surveys, these planes are raster reconstructions.
      // A shared boundary can move within the documented fitting residual.
      // Bound the entire resulting volume change by area × source uncertainty;
      // the separate strict tile-volume and CAD repair budgets remain 0.01%.
      const jointVolumeBound = (roofArea * fitToleranceM * 1000) / scale;
      assert.ok(
        Math.abs(volume - expectedVolume) <=
          jointVolumeBound + expectedVolume * 1e-4,
        "independent facet integration preserves the shallow main roof and low annex volume",
      );
      const check = probe(model, (fitToleranceM * 1000) / scale + 0.005);
      let count = 0,
        low = 0,
        sloped = 0;
      for (const [at, triangle] of triangles.entries()) {
        // Sub-resolution slivers are not useful height probes. Their area is
        // nevertheless included in the independent volume integral above.
        if (area(triangle) <= 0.0001) continue;
        check(centroid(triangle), `${element.tags?.name} facet ${at}`);
        count++;
        const elevations = triangle.map(
          (point) => datum + ((point[2] - base) * scale) / 1000,
        );
        if (Math.max(...elevations) < 500) low++;
        if (Math.max(...elevations) - Math.min(...elevations) > 0.5) {
          sloped++;
          const high = elevations.indexOf(Math.max(...elevations)),
            lower = elevations.indexOf(Math.min(...elevations));
          check(
            centroid(
              triangle,
              [0, 1, 2].map((at) => (at === high ? 0.6 : 0.2)),
            ),
            `${element.tags?.name} high slope ${at}`,
          );
          check(
            centroid(
              triangle,
              [0, 1, 2].map((at) => (at === lower ? 0.6 : 0.2)),
            ),
            `${element.tags?.name} low slope ${at}`,
          );
        }
      }
      assert.ok(count > 40, "many actual reconstructed planes are checked");
      if (id === 63330323)
        assert.ok(
          sloped > 10,
          "Hall B keeps its curved roof's varying local slopes",
        );
      else
        assert.ok(
          low > 10,
          "Hall A retains the raster-supported low side annex",
        );
      // Compare against the original MNS pixels, rather than treating the fitted
      // facets as their own source of truth. Residuals include real raster noise,
      // median filtering and the explicitly documented 2 m effective sampling.
      const residuals: number[] = [];
      const printed = upward(model);
      for (let row = 0; row < raster.rows; row++)
        for (let col = 0; col < raster.cols; col++) {
          const index = row * raster.cols + col;
          const z = raster.mns[index],
            ground = raster.mnt[index];
          if (z - ground < 2 || z - ground > 200) continue;
          const geo = fromLambert93(
            raster.west + (col + 0.5) * raster.resolutionM,
            raster.north - (row + 0.5) * raster.resolutionM,
          );
          const [x, y] = printPoint(expoBbox, scale, datum, {
            ...geo,
            elevation: z,
          });
          const reconstructed = top(triangles, x, y);
          const actual = top(printed, x, y);
          if (Number.isFinite(reconstructed))
            residuals.push(
              Math.abs(datum + ((actual - base) * scale) / 1000 - z),
            );
        }
      residuals.sort((a, b) => a - b);
      assert.ok(
        residuals.length > 500,
        "many independent MNS values are compared",
      );
      const median = residuals[Math.floor(residuals.length * 0.5)],
        p95 = residuals[Math.floor(residuals.length * 0.95)];
      t.diagnostic(
        `Original 2 m MNS residuals: median ${median.toFixed(3)} m, p95 ${p95.toFixed(3)} m; ${residuals.length} pixels.`,
      );
      assert.ok(
        median < 0.5,
        "the reconstruction follows the dominant measured surface",
      );
      assert.ok(
        p95 < 1,
        "the original raster disagreement is bounded, not hidden as exact geometry",
      );
    });
  }

test("a reconstructed sloping roof retains an actual courtyard despite a high synthetic MNS canopy", async () => {
  const origin = [809000, 6484300];
  const geo = (x: number, y: number) =>
    fromLambert93(origin[0] + x, origin[1] + y);
  const element: OverpassElement = {
    type: "relation",
    id: -9000000001,
    tags: { building: "yes", type: "multipolygon" },
    members: [
      {
        type: "way",
        role: "outer",
        geometry: [
          [2, 2],
          [22, 2],
          [22, 22],
          [2, 22],
          [2, 2],
        ].map(([x, y]) => geo(x, y)),
      },
      {
        type: "way",
        role: "inner",
        geometry: [
          [8, 8],
          [16, 8],
          [16, 16],
          [8, 16],
          [8, 8],
        ].map(([x, y]) => geo(x, y)),
      },
    ],
  };
  // Both plane and canopy are explicitly synthetic. The 620 m canopy inside
  // the hole must not become any printable roof or courtyard column.
  const grid: IGNRoofGrid = {
    west: origin[0],
    south: origin[1],
    east: origin[0] + 24,
    north: origin[1] + 24,
    cols: 24,
    rows: 24,
    resolutionM: 1,
    mnt: new Float32Array(576).fill(520),
    mns: Float32Array.from({ length: 576 }, (_, index) => {
      const x = (index % 24) + 0.5,
        y = 23.5 - Math.floor(index / 24);
      return x > 8 && x < 16 && y > 8 && y < 16 ? 620 : 550 + x * 0.2;
    }),
  };
  const reconstructed = enriched(element, grid);
  const bbox = bboxFor([element]),
    scale = 2000,
    datum = 520;
  const model = await build([reconstructed.element], bbox, scale, datum);
  assert.equal(model.stats.lidarRoofCount, 1);
  checkClosedAndTiles(model);
  const check = probe(model);
  for (const triangle of sourceTriangles(
    reconstructed.roof.surfaces,
    bbox,
    scale,
    datum,
  ))
    check(centroid(triangle), "synthetic sloping roof outside the real hole");
  for (const [x, y] of [
    [10, 10],
    [14, 10],
    [10, 14],
    [14, 14],
  ])
    check(
      printPoint(bbox, scale, datum, { ...geo(x, y), elevation: datum }),
      "open courtyard above bare MNT",
      true,
    );
});

test("existing CRAIG geometry has priority over LiDAR enrichment and keeps its measured pitches when printed", async () => {
  const craig = JSON.parse(
    readFileSync(
      new URL("./fixtures/saint-etienne-craig-cityjson.json", import.meta.url),
      "utf8",
    ),
  );
  const metadata = {
    source: craig.provenance.source,
    year: craig.provenance.year,
  };
  const building = parseCityJSONBuildings(
    craig.document,
    metadata,
  ).buildings.find((building) => building.id === "1003794.00")!;
  const polygon = building.footprints[0];
  const element: OverpassElement = {
    type: "relation",
    id: -3000000002000,
    tags: {
      building: "yes",
      height: String(building.height),
      "printmap:source": metadata.source,
    },
    groundElevation: building.groundElevation,
    roofSurfaces: building.roofSurfaces,
    roofSource: metadata.source,
    members: [
      { type: "way", role: "outer", geometry: polygon.outer },
      ...polygon.holes.map((geometry) => ({
        type: "way",
        role: "inner",
        geometry,
      })),
    ],
  };
  const bbox = bboxFor([element]);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error(
      "an existing CRAIG roof must not request or replace itself with a raster",
    );
  };
  let enrichedResult: Awaited<ReturnType<typeof enrichIGNRoofs>>;
  try {
    enrichedResult = await enrichIGNRoofs(
      [element],
      bbox,
      new AbortController().signal,
    );
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(enrichedResult.elements[0], element);
  assert.equal(enrichedResult.buildingCount, 0);
  const model = await build(
    enrichedResult.elements,
    bbox,
    craig.scale,
    craig.datumElevation,
  );
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.lidarRoofCount, 0);
  checkClosedAndTiles(model);
  const check = probe(model);
  for (const triangle of sourceTriangles(
    building.roofSurfaces,
    bbox,
    craig.scale,
    craig.datumElevation,
  ))
    check(
      centroid(triangle),
      "CRAIG measured roof retains its genuine source elevation",
    );
  const nativeMaximum = Math.max(
    ...building.roofSurfaces.flatMap((surface) =>
      surface.outer.map((point) => point.elevation),
    ),
  );
  assert.ok(Math.abs(nativeMaximum - 555.181472) < 1e-9);
  assert.ok(
    Math.abs(
      model.dimensions.heightMm -
        printPoint(bbox, craig.scale, craig.datumElevation, {
          ...building.roofSurfaces[0].outer[0],
          elevation: nativeMaximum,
        })[2],
    ) < 0.01,
  );
});

function syntheticStep(
  left: (y: number) => number,
  right: (y: number) => number,
  reverse = false,
) {
  const geo = (x: number, y: number) => fromLambert93(809000 + x, 6484300 + y);
  const panel = (
    x0: number,
    x1: number,
    height: (y: number) => number,
  ): RoofSurface => ({
    outer: [
      [x0, 0],
      [x1, 0],
      [x1, 10],
      [x0, 10],
      [x0, 0],
    ].map(([x, y]) => ({ ...geo(x, y), elevation: height(y) })),
    holes: [],
  });
  const roofSurfaces = [panel(0, 10, left), panel(10, 20, right)];
  if (reverse) roofSurfaces.reverse();
  const element: OverpassElement = {
    type: "way",
    id: -9000000002,
    geometry: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
      [0, 0],
    ].map(([x, y]) => geo(x, y)),
    tags: {
      building: "yes",
      height: String(
        Math.max(
          ...roofSurfaces.flatMap((surface) =>
            surface.outer.map((point) => point.elevation),
          ),
        ) - 520,
      ),
      "printmap:roof_reconstruction": "lidar",
      "printmap:roof_resolution_m": "2",
      "printmap:roof_fit_tolerance_m": ".59",
    },
    groundElevation: 520,
    roofSurfaces,
    roofSource: IGN_ROOF_SOURCE,
  };
  return { element, geo };
}

test("a genuine seven-metre roof step keeps its vertical wall and outward normals in either source order", async () => {
  let originalVolume: number | undefined;
  for (const reverse of [false, true]) {
    const { element, geo } = syntheticStep(
      () => 550,
      () => 557,
      reverse,
    );
    const bbox = bboxFor([element]),
      scale = 2000;
    const model = await build([element], bbox, scale, 520);
    assert.equal(model.stats.lidarRoofCount, 1);
    const volume = checkClosedAndTiles(model);
    if (originalVolume != null)
      assert.ok(
        Math.abs(volume - originalVolume) / volume < 1e-5,
        "source order does not invert the step wall or change the enclosed volume",
      );
    originalVolume = volume;
    const check = probe(model);
    check(
      printPoint(bbox, scale, 520, { ...geo(9, 5), elevation: 550 }),
      "low roof beside the genuine step",
    );
    check(
      printPoint(bbox, scale, 520, { ...geo(11, 5), elevation: 557 }),
      "high roof beside the genuine step",
    );
    const a = printPoint(bbox, scale, 520, { ...geo(10, 0), elevation: 550 });
    const b = printPoint(bbox, scale, 520, { ...geo(10, 10), elevation: 557 });
    const east = printPoint(bbox, scale, 520, {
      ...geo(20, 5),
      elevation: 550,
    });
    const west = printPoint(bbox, scale, 520, { ...geo(0, 5), elevation: 550 });
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    let walls = 0;
    for (let at = 0; at < model.indices.length; at += 3) {
      if (PRINT_LAYERS[model.faceLayers[at / 3]] !== "buildings") continue;
      const points = Array.from(
        model.indices.subarray(at, at + 3),
        (id) =>
          Array.from(model.positions.subarray(id * 3, id * 3 + 3)) as Point,
      ) as Triangle;
      if (
        !points.every(
          (p) =>
            Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length <
            0.00001,
        ) ||
        Math.min(...points.map((p) => p[2])) < a[2] - 0.01 ||
        Math.max(...points.map((p) => p[2])) < b[2] - 0.01
      )
        continue;
      const [p, q, r] = points;
      const nx = (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]);
      const ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
      assert.ok(
        nx * (east[0] - west[0]) + ny * (east[1] - west[1]) < 0,
        "the vertical step faces the low roof, even when the first pan is lower",
      );
      walls++;
    }
    assert.ok(
      walls > 0,
      "the actual vertical step is present, rather than flattened into an inclined roof",
    );
  }
});

test("small fitted joins are continuous and a genuine crossing preserves both original slopes without averaging their ends", async () => {
  const small = syntheticStep(
    (y) => 550 + y * 0.02,
    (y) => 550.2 - y * 0.02,
  );
  const bbox = bboxFor([small.element]),
    scale = 2000;
  const model = await build([small.element], bbox, scale, 520);
  assert.equal(model.stats.lidarRoofCount, 1);
  checkClosedAndTiles(model);
  probe(model)(
    printPoint(bbox, scale, 520, { ...small.geo(10, 5), elevation: 550.1 }),
    "bounded shared fitted joint",
  );
  const large = syntheticStep(
    (y) => 550 + y * 0.2,
    (y) => 552 - y * 0.2,
  );
  const crossed = await build([large.element], bbox, scale, 520);
  assert.equal(
    crossed.stats.lidarRoofCount,
    1,
    "two original planes are split at their exact intersection, without moving their end levels",
  );
  checkClosedAndTiles(crossed);
  const check = probe(crossed);
  for (const y of [0.5, 9.5]) {
    check(
      printPoint(bbox, scale, 520, {
        ...large.geo(9, y),
        elevation: 550 + y * 0.2,
      }),
      "the original left plane at the crossing",
    );
    check(
      printPoint(bbox, scale, 520, {
        ...large.geo(11, y),
        elevation: 552 - y * 0.2,
      }),
      "the original right plane at the crossing",
    );
  }
  check(
    printPoint(bbox, scale, 520, { ...large.geo(10, 5), elevation: 551 }),
    "the exact two-plane intersection",
  );
});
