import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";
import { createLocalProjection, createProjectionForBbox } from "../src/lib/projection";
import { initialAssemblyDatum } from "../src/lib/assembly-project";
import { sampleElevation } from "../src/lib/elevation/sample-grid";
import { parseElements } from "../src/lib/osm/parse-elements";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";
import type { AssemblyFrame, PrintInput, PrintMesh } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const source = JSON.parse(
  readFileSync(new URL("./fixtures/saint-etienne-partial-craig-roofs.json", import.meta.url), "utf8"),
) as { bbox: BBox; element: OverpassElement; elevationGrid: ElevationGrid };
const frame: AssemblyFrame = {
  originLat: (source.bbox[0] + source.bbox[2]) / 2,
  elevationDatumM: source.elevationGrid.minElev,
};
const anchor = createLocalProjection(frame.originLat, (source.bbox[1] + source.bbox[3]) / 2);
const scale = 2000;
const sideMetres = 145 * scale / 1000;

function plate(x: number, y: number, elements: OverpassElement[] = [], plateScale = scale): PrintInput {
  const side = 145 * plateScale / 1000;
  const [west, south] = anchor.unproject(x, y);
  const [east, north] = anchor.unproject(x + side, y + side);
  const bbox: BBox = [south, west, north, east];
  // The two grids share their boundary samples and physical step. Each retains
  // its own real local minimum, deliberately different from the common datum.
  const points: number[] = [];
  const rows = 17, cols = 17;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const [lon, lat] = anchor.unproject(
        x + col * side / (cols - 1),
        y + row * side / (rows - 1),
      );
      points.push(sampleElevation(source.elevationGrid, lat, lon));
    }
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 1, rows: 1 };
  return {
    osmData: { elements }, bbox, scale: plateScale, settings,
    assemblyFrame: { ...frame },
    elevationGrid: {
      rows, cols, points, south, west, north, east,
      minElev: Math.min(...points), maxElev: Math.max(...points),
      source: source.elevationGrid.source,
      resolutionM: side / (cols - 1),
    },
  };
}

function topAt(mesh: PrintMesh, x: number, y: number): number {
  let top = -Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (index) =>
      mesh.positions.subarray(index * 3, index * 3 + 3),
    );
    const determinant = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-10) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      top = Math.max(top, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return top;
}
function near(actual: number, expected: number, tolerance = 0.002) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
}

for (const direction of ["east-west", "north-south"] as const)
  test(`separately built 145 mm ${direction} plates share real terrain heights and physical scale`, async () => {
    const first = direction === "east-west"
      ? plate(-sideMetres, -295, [source.element])
      : plate(-sideMetres / 2, -sideMetres);
    const second = direction === "east-west"
      ? plate(0, -295)
      : plate(-sideMetres / 2, 0);
    const originalGrids = JSON.stringify([first.elevationGrid, second.elevationGrid]);
    assert.notEqual(first.elevationGrid!.minElev, second.elevationGrid!.minElev);
    assert.ok(first.elevationGrid!.minElev > frame.elevationDatumM);
    const models = [await buildPrintModel(first), await buildPrintModel(second)];
    for (let i = 0; i < models.length; i++) {
      assertClosedSolid(models[i]);
      assert.equal(models[i].stats.components, 1);
      near(models[i].dimensions.widthMm, 145, 0.0001);
      near(models[i].dimensions.depthMm, 145, 0.0001);
      const dimensions = getBboxDimensions([first, second][i].bbox, scale, frame.originLat);
      near(dimensions.widthMm, 145, 1e-7);
      near(dimensions.heightMm, 145, 1e-7);
    }
    for (let i = 0; i < 17; i++) {
      const across = -72.5 + i * 145 / 16;
      const left = direction === "east-west" ? [72.5, across] : [across, 72.5];
      const right = direction === "east-west" ? [-72.5, across] : [across, -72.5];
      const elevation = first.elevationGrid!.points[
        direction === "east-west" ? i * 17 + 16 : 16 * 17 + i
      ];
      const expected = first.settings.base.basePlateThicknessMm + (elevation - frame.elevationDatumM) * 1000 / scale;
      near(topAt(models[0], ...left as [number, number]), expected);
      near(topAt(models[1], ...right as [number, number]), expected);
    }
    assert.equal(JSON.stringify([first.elevationGrid, second.elevationGrid]), originalGrids);
    if (direction === "east-west") {
      assert.equal(models[0].stats.realRoofCount, 1);
      const projection = createProjectionForBbox(first.bbox, frame.originLat);
      const parsed = parseElements([source.element], first.bbox, scale, frame.originLat);
      assert.equal(parsed.buildings.length, 1);
      const firstPoint = parsed.buildings[0].polygon.outer[0];
      const nativeGround = source.element.members!.filter((m) => m.role === "outer").flatMap((m) => m.geometry!);
      assert.ok(Math.min(...nativeGround.map((point) => {
        const xy = projection.project(point.lon, point.lat);
        return Math.hypot(firstPoint[0] - xy[0] * 1000 / scale, firstPoint[1] - xy[1] * 1000 / scale);
      })) < 1e-7, "the parser shares the exact frame used for terrain and source roof projection");
      let count = 0;
      for (const surface of source.element.roofSurfaces!) {
        if (!surface.outer.every((p) => p.elevation === surface.outer[0].elevation)) continue;
        const rings = [surface.outer, ...surface.holes];
        const points = rings.flatMap((ring) => ring.map((p) => projection.project(p.lon, p.lat).map((v) => v * 1000 / scale)));
        const holes: number[] = [];
        let offset = surface.outer.length;
        for (const hole of surface.holes) { holes.push(offset); offset += hole.length; }
        const indices = earcut(points.flat(), holes);
        let largest = 0, probe: [number, number] | undefined;
        for (let i = 0; i < indices.length; i += 3) {
          const [a,b,c] = indices.slice(i,i+3).map((index) => points[index]);
          const area = Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
          if (area > largest) { largest = area; probe = [(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3]; }
        }
        assert.ok(probe);
        near(topAt(models[0], ...probe), 3 + (surface.outer[0].elevation - frame.elevationDatumM) * 1000 / scale);
        count++;
      }
      assert.equal(count, 3);
    }
  });

test("an assembly rejects an invalid or too-high datum instead of flattening lower ground", async () => {
  const input = plate(0, -295);
  await assert.rejects(buildPrintModel({...input, assemblyFrame: {...frame, originLat: NaN}}), /repère commun/);
  await assert.rejects(buildPrintModel({...input, assemblyFrame: {...frame, elevationDatumM: input.elevationGrid!.minElev + 1}}), /datum commun/);
  // Legacy projects keep their original bbox-centred projection and local datum.
  const old = await buildPrintModel({...input, assemblyFrame: undefined});
  assertClosedSolid(old);
  const before = createProjectionForBbox(input.bbox), same = createProjectionForBbox(input.bbox, undefined);
  assert.deepEqual(before.project(input.bbox[1], input.bbox[0]), same.project(input.bbox[1], input.bbox[0]));
});


test("the real Rio ocean and terrain use the assembly datum without rewriting source elevations", async () => {
  const coast = JSON.parse(readFileSync(new URL("./fixtures/rio-copacabana-ocean.json", import.meta.url), "utf8")) as {
    bbox: BBox; scale: number; elements: OverpassElement[]; elevationGrid: ElevationGrid;
  };
  const snapshot = JSON.stringify(coast);
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { cols: 2, rows: 2 };
  const assemblyFrame = {
    originLat: (coast.bbox[0] + coast.bbox[2]) / 2,
    elevationDatumM: coast.elevationGrid.minElev - 10,
  };
  const model = await buildPrintModel({
    bbox: coast.bbox, scale: coast.scale, osmData: { elements: coast.elements },
    elevationGrid: coast.elevationGrid, settings, assemblyFrame,
  });
  const volume = assertClosedSolid(model);
  const tileVolume = model.tiles.reduce((sum, tile) => sum + assertClosedSolid(tile), 0);
  assert.equal(model.tiles.length, 4);
  assert.ok(Math.abs(volume-tileVolume)/volume < 1e-4);
  const projection = createProjectionForBbox(coast.bbox, assemblyFrame.originLat);
  const [x,y] = projection.project(-43.179, -22.972).map((v) => v * 1000 / coast.scale);
  near(topAt(model,x,y), 3 - assemblyFrame.elevationDatumM * 1000 / coast.scale);
  assert.equal(JSON.stringify(coast),snapshot);
});


test("the saved Saint-Étienne terrain stays below 40 mm with the project initial datum at 1:5000", async () => {
  const input = plate(-362.5, -362.5, [], 5000);
  const grid = input.elevationGrid!;
  input.assemblyFrame = {
    originLat: frame.originLat,
    elevationDatumM: initialAssemblyDatum(grid.minElev),
  };
  const model = await buildPrintModel(input);
  assertClosedSolid(model);
  near(model.dimensions.widthMm, 145, 0.0001);
  near(model.dimensions.depthMm, 145, 0.0001);
  near(model.dimensions.heightMm, 3 + (grid.maxElev - input.assemblyFrame.elevationDatumM) * 1000 / input.scale);
  assert.ok(model.dimensions.heightMm < 40, "the real inland relief does not become a sea-level block exceeding 100 mm");
  assert.ok(model.dimensions.heightMm > 10, "the acquired relief is retained instead of being flattened");
});
