import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import {
  DEFAULT_MODEL_SETTINGS,
  PRINT_PROFILES,
} from "../src/store/use-scene-store";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";
import type { PrintMesh } from "../src/types/print";
import { pointInPolygon } from "../src/lib/polygon/point-in-polygon";
import { assertClosedSolid } from "./helpers/solid";

const source = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/saint-etienne-partial-craig-roofs.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  element: OverpassElement;
  bbox: BBox;
  scale: number;
  elevationGrid: ElevationGrid;
};

function topAt(mesh: PrintMesh, x: number, y: number) {
  let top = -Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (v) =>
      Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)),
    );
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (d <= 1e-10) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / d;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / d;
    if (u >= 0 && v >= 0 && u + v <= 1)
      top = Math.max(top, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return top;
}

for (const realTerrain of [false, true])
  test(`the actual incomplete Badouillière survey retains its three horizontal roofs and missing coverage on ${realTerrain ? "the saved LiDAR terrain" : "a flat datum control"}`, async () => {
    const { element, bbox, scale } = source;
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.print = { ...PRINT_PROFILES.detail.print };
    settings.base.grid = { cols: 2, rows: 2 };
    settings.base.topographyEnabled = true;
    const datum = element.groundElevation!;
    const elevationGrid: ElevationGrid = realTerrain
      ? source.elevationGrid
      : {
        rows: 2,
        cols: 2,
        points: Array(4).fill(datum),
        minElev: datum,
        maxElev: datum,
        south: bbox[0],
        west: bbox[1],
        north: bbox[2],
        east: bbox[3],
        source: "IGN69 · synthetic flat datum control for the actual source roof",
      };
    const model = await buildPrintModel({
      bbox,
      scale,
      settings,
      osmData: { elements: [element] },
      elevationGrid,
    });
    const volume = assertClosedSolid(model);
    assert.equal(model.tiles.length, 4);
    const tileVolume = model.tiles.reduce(
      (total, tile) => total + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(tileVolume - volume) / volume < 0.0001);
    assert.equal(model.stats.realRoofCount, 1);
    assert.ok(
      model.warnings.some((text) => text.includes("emprises sans toiture")),
    );
    const { project } = createProjectionForBbox(bbox);
    const sf = 1000 / scale,
      base = settings.base.basePlateThicknessMm;
    const groundZ = base + (datum - elevationGrid.minElev) * sf;
    const terrainOnly = realTerrain
      ? await buildPrintModel({
          bbox,
          scale,
          settings,
          osmData: { elements: [] },
          elevationGrid,
        })
      : null;
    const panels = element.roofSurfaces!.map((surface) => {
      const points = [surface.outer, ...surface.holes].flatMap((ring) =>
        ring.map((point) => {
          const xy = project(point.lon, point.lat);
          return [xy[0] * sf, xy[1] * sf, groundZ + (point.elevation - datum) * sf];
        }),
      );
      let offset = surface.outer.length;
      const holes = surface.holes.map((ring) => {
        const start = offset;
        offset += ring.length;
        return start;
      });
      const indices = earcut(
        points.flatMap((p) => p.slice(0, 2)),
        holes,
      );
      return { points, indices };
    });
    const samples: { x: number; y: number; z: number }[] = [];
    for (const { points, indices } of panels) {
      let largest = 0,
        sample;
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = indices.slice(i, i + 3).map((index) => points[index]);
        const area = Math.abs(
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        );
        if (area > largest) {
          largest = area;
          sample = {
            x: (a[0] + b[0] + c[0]) / 3,
            y: (a[1] + b[1] + c[1]) / 3,
            z: (a[2] + b[2] + c[2]) / 3,
          };
        }
      }
      if (sample && points.every((p) => Math.abs(p[2] - points[0][2]) < 1e-8))
        samples.push(sample);
    }
    const heights = [];
    for (const point of samples) {
      const expected = Math.max(
        ...panels.flatMap(({ points, indices }) => {
          const faces = [];
          for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = indices
              .slice(i, i + 3)
              .map((index) => points[index]);
            const d =
              (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (Math.abs(d) < 1e-10) continue;
            const u =
              ((point.x - a[0]) * (c[1] - a[1]) -
                (point.y - a[1]) * (c[0] - a[0])) /
              d;
            const v =
              ((b[0] - a[0]) * (point.y - a[1]) -
                (b[1] - a[1]) * (point.x - a[0])) /
              d;
            if (u >= 0 && v >= 0 && u + v <= 1)
              faces.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
          }
          return faces;
        }),
      );
      if (Number.isFinite(expected)) {
        const actual = topAt(model, point.x, point.y);
        assert.ok(
          Math.abs(actual - expected) < 0.002,
          `roof ${actual} must follow source ${expected}, sample ${JSON.stringify(point)}`,
        );
        const tile = model.tiles.find(
          (item) => item.col === (point.x < 0 ? 0 : 1) &&
            item.row === (point.y < 0 ? 0 : 1),
        )!;
        const centreX = (tile.col - 0.5) * model.dimensions.widthMm / 2;
        const centreY = (tile.row - 0.5) * model.dimensions.depthMm / 2;
        const tileHeight = topAt(tile, point.x - centreX, point.y - centreY);
        assert.ok(
          Math.abs(tileHeight - expected) < 0.002,
          `the tile keeps the horizontal survey panel at ${expected}, got ${tileHeight}`,
        );
        heights.push(actual);
      }
    }
    // These three genuinely horizontal source panels are independent of the
    // triangulation convention for the survey's nonplanar polygon faces.
    assert.equal(heights.length, 3);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 5);
    const ground = element
      .members!.filter((m) => m.role === "outer")
      .map((m) =>
        m.geometry!.map((p) => {
          const xy = project(p.lon, p.lat);
          return [xy[0] * sf, xy[1] * sf] as [number, number];
        }),
      );
    const roofMasks = element.roofSurfaces!.map((s) =>
      [s.outer, ...s.holes].map((ring) =>
        ring.map((p) => {
          const xy = project(p.lon, p.lat);
          return [xy[0] * sf, xy[1] * sf] as [number, number];
        }),
      ),
    );
    const xs = ground.flat().map((p) => p[0]),
      ys = ground.flat().map((p) => p[1]);
    let uncovered = 0;
    let repairedGround = false;
    for (let x = Math.min(...xs) + 0.07; x < Math.max(...xs); x += 0.15)
      for (let y = Math.min(...ys) + 0.09; y < Math.max(...ys); y += 0.15) {
        if (!ground.some((ring) => pointInPolygon(x, y, ring))) continue;
        // Stay well away from roof boundaries and the 0.005 mm source repairs.
        if (
          [
            [0, 0],
            [0.025, 0],
            [-0.025, 0],
            [0, 0.025],
            [0, -0.025],
          ].some(([dx, dy]) =>
            roofMasks.some(
              ([outer, ...holes]) =>
                pointInPolygon(x + dx, y + dy, outer) &&
                !holes.some((hole) => pointInPolygon(x + dx, y + dy, hole)),
            ),
          )
        )
          continue;
        const expected = terrainOnly ? topAt(terrainOnly, x, y) : base;
        const actual = topAt(model, x, y);
        // A declared five-micron contact opening may remove material from a
        // horizontal ground film. Never allow a new roof/block in missing data,
        // and do not increase the existing contact clearance or volume budget.
        assert.ok(
          actual >= expected - 0.00501 && actual <= expected + 0.002,
          `uncovered ground ${x},${y}: ${actual} must remain terrain ${expected}`,
        );
        repairedGround ||= actual < expected - 0.002;
        uncovered++;
      }
    assert.ok(
      uncovered > 100,
      "check actual missing coverage inside the source ground footprint",
    );
    if (repairedGround)
      assert.ok(
        model.warnings.some((text) => /contact\(s\).*0,005 mm/.test(text)),
        "a ground cut beyond export rounding needs the existing contact-repair disclosure",
      );
  });

test("a cut entirely inside the actual missing survey coverage stays terrain", async () => {
  // A mesh-level cut inside the native ground mask, with no roof projection.
  // Coordinates remain those of the actual source; this is not a city preset.
  const bbox: BBox = [
    45.43251505146095, 4.387232146463394, 45.432552944651, 4.387286146463394,
  ];
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.print = { ...PRINT_PROFILES.detail.print };
  settings.base.topographyEnabled = false;
  const model = await buildPrintModel({
    bbox,
    scale: source.scale,
    settings,
    elevationGrid: null,
    osmData: { elements: [source.element] },
  });
  assertClosedSolid(model);
  assert.equal(model.stats.buildingCount, 0);
  assert.ok(
    Math.abs(model.dimensions.heightMm - settings.base.basePlateThicknessMm) <
      0.00001,
  );
  assert.ok(
    model.warnings.some((text) => text.includes("emprises sans toiture")),
  );
});
