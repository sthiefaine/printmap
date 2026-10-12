import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import type { BBox, OverpassElement } from "../src/types/osm";
import type { Point2D } from "../src/types/geometry";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-sainte-anne-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "bbox" | "osmData" | "elevationGrid"> & {
  fullChurchBbox: BBox;
};

/** Read the exported upper surface independently of the roof builder. */
function buildingSurfaceAt(mesh: PrintMesh, x: number, y: number) {
  let maximum = -Infinity;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-12) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
      maximum = Math.max(maximum, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return maximum;
}

for (const scale of [6000, 7000, 10000, 12000]) {
  test(`Sainte-Anne's complete survey preserves the nave and spire at 1:${scale}, including closed tiles`, async () => {
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    settings.base.grid = { rows: 2, cols: 2 };
    assert.equal(settings.print.simplifyMm, 0.12);
    const model = await buildPrintModel({
      ...fixture,
      bbox: fixture.fullChurchBbox,
      scale,
      settings,
    });
    const church = fixture.osmData.elements[0];
    assert.equal(church.roofSurfaces!.length, 268);
    assert.equal(church.groundElevation, 44.63);
    assert.equal(model.stats.realRoofCount, 1);
    assert.equal(model.stats.buildingCount, 1);
    assert.equal(model.stats.components, 1);
    assert.ok(
      !model.warnings.some((warning) => /toiture.*repli/i.test(warning)),
    );
    if (scale === 7000) {
      const repairWarnings = model.warnings.filter((warning) =>
        /contact\(s\) de précision dans les relevés de bâtiments/.test(warning),
      );
      assert.equal(repairWarnings.length, 1);
      assert.match(repairWarnings[0], /^2 contact\(s\)/);
      assert.match(repairWarnings[0], /trois passages au maximum/);
      assert.match(repairWarnings[0], /retrait cumulé limité à 0,01 %/);
      assert.match(repairWarnings[0], /Les cavités sont conservées/);
    }

    const sf = 1000 / scale;
    const toPrintElevation = (elevation: number) =>
      settings.base.basePlateThicknessMm +
      (elevation - fixture.elevationGrid!.minElev) * sf;
    const projection = createProjectionForBbox(fixture.fullChurchBbox);
    // Interior barycentre of the surveyed nave panel, whose slope must survive.
    const nave = church.roofSurfaces![156].outer;
    const sourcePoints = [nave[0], nave[1], nave[11]];
    const [x, y] = projection
      .project(
        sourcePoints.reduce((sum, point) => sum + point.lon, 0) / 3,
        sourcePoints.reduce((sum, point) => sum + point.lat, 0) / 3,
      )
      .map((value) => value * sf);
    const naveElevation =
      sourcePoints.reduce((sum, point) => sum + point.elevation, 0) / 3;
    assert.ok(Math.abs(naveElevation - 68.67833333333333) < 1e-9);
    assert.ok(
      Math.abs(
        buildingSurfaceAt(model, x, y) - toPrintElevation(naveElevation),
      ) < 0.03,
      "the nave retains its surveyed altitude instead of the bell tower's height",
    );
    assert.ok(
      Math.abs(model.dimensions.heightMm - toPrintElevation(111.971)) < 0.03,
      "the spire retains its actual IGN69 source altitude",
    );
    const vertices = new Set<number>();
    for (let face = 0; face < model.faceLayers.length; face++)
      if (PRINT_LAYERS[model.faceLayers[face]] === "buildings")
        for (const index of model.indices.subarray(face * 3, face * 3 + 3))
          vertices.add(index);
    const points = [...vertices].map((index) =>
      Array.from(model.positions.subarray(index * 3, index * 3 + 3)),
    );
    const spire = points.filter((point) => point[2] > toPrintElevation(100));
    assert.ok(spire.length > 0);
    for (const axis of [0, 1]) {
      const span = (values: number[][]) =>
        Math.max(...values.map((point) => point[axis])) -
        Math.min(...values.map((point) => point[axis]));
      assert.ok(
        span(spire) < span(points) * 0.15,
        "only the narrow spire reaches the highest source levels",
      );
    }
    const volume = assertClosedSolid(model);
    assert.equal(model.tiles.length, 4);
    const tileVolume = model.tiles.reduce(
      (total, tile) => total + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
  });
}

for (const disabledSurvey of [false, true]) {
  test(`${disabledSurvey ? "disabled roof surveys" : "generic buildings"} still use the print profile's contour simplification`, async () => {
    const bbox: BBox = [0, 0, 0.001, 0.001];
    const projection = createProjectionForBbox(bbox);
    // A 0.1 mm indentation is intentionally below the generic profile's 0.12 mm tolerance.
    const points: Point2D[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [1, 10],
      [1, 9.9],
      [-1, 9.9],
      [-1, 10],
      [-10, 10],
      [-10, -10],
    ];
    const geometry = points.map(([x, y]) => {
      const [lon, lat] = projection.unproject(x, y);
      return { lon, lat };
    });
    const building: OverpassElement = {
      type: "way",
      id: 1,
      tags: { building: "yes", height: "8" },
      geometry,
      ...(disabledSurvey
        ? {
            groundElevation: 0,
            roofSurfaces: [
              {
                outer: geometry.map((point) => ({ ...point, elevation: 8 })),
                holes: [],
              },
            ],
          }
        : {}),
    };
    const volumes: number[] = [];
    for (const simplifyMm of [0, 0.12]) {
      const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
      settings.print.simplifyMm = simplifyMm;
      settings.features.buildings.roofs = false;
      const model = await buildPrintModel({
        bbox,
        scale: 1000,
        osmData: { elements: [building] },
        elevationGrid: null,
        settings,
      });
      assert.equal(model.stats.realRoofCount, 0);
      volumes.push(assertClosedSolid(model));
    }
    assert.ok(
      volumes[1] - volumes[0] > 1,
      "generic simplification removes the shallow indentation instead of preserving every source vertex",
    );
  });
}
