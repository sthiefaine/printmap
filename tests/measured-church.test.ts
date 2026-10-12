import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { assertClosedSolid } from "./helpers/solid";
import { PRINT_LAYERS, type PrintInput } from "../src/types/print";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-sainte-anne-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid"> & {
  fullChurchBbox: PrintInput["bbox"];
};

for (const label of ["Peyrou crop", "whole church"] as const) {
  test(`Sainte-Anne retains its measured nave and narrow spire in the ${label}`, async () => {
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    settings.base.grid = { cols: 2, rows: 2 };
    const model = await buildPrintModel({
      ...fixture,
      bbox: label === "Peyrou crop" ? fixture.bbox : fixture.fullChurchBbox,
      settings,
    });
    assert.equal(
      model.stats.realRoofCount,
      1,
      "the surveyed church must not become a maximum-height extrusion",
    );
    assert.equal(model.stats.buildingCount, 1);
    assert.equal(model.stats.discardedFeatures, 0);
    assert.ok(
      !model.warnings.some((warning) => /toiture.*repli/i.test(warning)),
    );
    const volume = assertClosedSolid(model);
    assert.equal(model.tiles.length, 4);
    const tileVolume = model.tiles.reduce(
      (sum, tile) => sum + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
    const buildingLayer = PRINT_LAYERS.indexOf("buildings");
    const vertices = new Set<number>();
    for (let face = 0; face < model.faceLayers.length; face++)
      if (model.faceLayers[face] === buildingLayer)
        for (const vertex of model.indices.subarray(face * 3, face * 3 + 3))
          vertices.add(vertex);
    const points = [...vertices].map((index) =>
      Array.from(model.positions.subarray(index * 3, index * 3 + 3)),
    );
    const maxZ = Math.max(...points.map((point) => point[2]));
    const high = points.filter((point) => point[2] > maxZ - 8);
    const xRange = (values: number[][]) =>
      Math.max(...values.map((p) => p[0])) -
      Math.min(...values.map((p) => p[0]));
    const yRange = (values: number[][]) =>
      Math.max(...values.map((p) => p[1])) -
      Math.min(...values.map((p) => p[1]));
    assert.ok(
      xRange(high) < xRange(points) * 0.5 &&
        yRange(high) < yRange(points) * 0.5,
      "only the bell tower reaches the upper eight millimetres, not the nave footprint",
    );
    const groundZ =
      settings.base.basePlateThicknessMm +
      (44.63 - fixture.elevationGrid!.minElev) * (1000 / fixture.scale);
    assert.ok(
      Math.abs(maxZ - (groundZ + 67.341 * (1000 / fixture.scale))) < 0.03,
      "the IGN69 source roof altitude uses the same terrain datum",
    );
  });
}

test("the live Sainte-Anne neighbourhood keeps the nave below its narrow spire at 200 mm", async () => {
  const neighbourhood = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-sainte-anne-neighbourhood.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Omit<PrintInput, "settings">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = { cols: 2, rows: 2 };
  const model = await buildPrintModel({ ...neighbourhood, settings });
  const church = parseElements(
    neighbourhood.osmData.elements,
    neighbourhood.bbox,
    neighbourhood.scale,
  ).buildings.find((building) => building.sourceId === "MMM/B145689")!;
  const minimum = [0, 1].map((axis) =>
    Math.min(...church.polygon.outer.map((point) => point[axis])),
  );
  const maximum = [0, 1].map((axis) =>
    Math.max(...church.polygon.outer.map((point) => point[axis])),
  );
  const churchPoints: number[][] = [];
  for (let at = 0; at < model.positions.length; at += 3) {
    const point = Array.from(model.positions.subarray(at, at + 3));
    if (
      point[0] >= minimum[0] - 0.02 &&
      point[0] <= maximum[0] + 0.02 &&
      point[1] >= minimum[1] - 0.02 &&
      point[1] <= maximum[1] + 0.02
    )
      churchPoints.push(point);
  }
  const maxZ = Math.max(...churchPoints.map((point) => point[2]));
  const sf = 1000 / neighbourhood.scale;
  assert.ok(
    Math.abs(
      maxZ - (3 + (111.971 - neighbourhood.elevationGrid!.minElev) * sf),
    ) < 0.03,
    "the bell tower keeps its measured IGN69 altitude",
  );
  const spire = churchPoints.filter((point) => point[2] > maxZ - 8);
  for (const axis of [0, 1]) {
    const span = (points: number[][]) =>
      Math.max(...points.map((point) => point[axis])) -
      Math.min(...points.map((point) => point[axis]));
    assert.ok(
      span(spire) < span(churchPoints) * 0.1,
      "the upper eight millimetres belong to the spire, not the whole nave",
    );
  }
  // Interior barycentre of measured nave panel 156 (vertices 0, 1 and 11).
  const nave = church.roofSurfaces![156].outer;
  const sourcePoints = [nave[0], nave[1], nave[11]];
  const [x, y] = createProjectionForBbox(neighbourhood.bbox)
    .project(
      sourcePoints.reduce((sum, point) => sum + point.lon, 0) / 3,
      sourcePoints.reduce((sum, point) => sum + point.lat, 0) / 3,
    )
    .map((value) => value * sf);
  const sourceElevation =
    sourcePoints.reduce((sum, point) => sum + point.elevation, 0) / 3;
  const naveHeights: number[] = [];
  for (let at = 0; at < model.indices.length; at += 3) {
    if (PRINT_LAYERS[model.faceLayers[at / 3]] !== "buildings") continue;
    const [a, b, c] = Array.from(model.indices.subarray(at, at + 3), (index) =>
      Array.from(model.positions.subarray(index * 3, index * 3 + 3)),
    );
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-10) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= 0 && v >= 0 && u + v <= 1)
      naveHeights.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  const expectedNave =
    3 + (sourceElevation - neighbourhood.elevationGrid!.minElev) * sf;
  assert.ok(
    naveHeights.some((height) => Math.abs(height - expectedNave) < 0.03),
    "the pitched nave stays at its source elevation instead of the spire height",
  );
  assert.ok(maxZ - expectedNave > 80);
  assert.ok(model.stats.realRoofCount >= 86);
  assert.equal(model.stats.components, 1);
  assert.ok(
    model.warnings.some((warning) =>
      /contact\(s\).*trois passages.*0,01 %/.test(warning),
    ),
  );
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
});
