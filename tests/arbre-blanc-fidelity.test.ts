import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { makeMeasuredRoof } from "../src/lib/mesh/roof-solid";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import type { Point2D } from "../src/types/geometry";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "bbox" | "scale" | "osmData" | "elevationGrid">;

function upperBuildingSurface(mesh: PrintMesh, x: number, y: number) {
  let highest = -Infinity;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (det <= 1e-12) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
      highest = Math.max(highest, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return highest;
}

test("Arbre Blanc's 69 terrace panels retain the volume of their measured upper envelope", async () => {
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    const sf = 1000 / fixture.scale;
    const projection = createProjectionForBbox(fixture.bbox);
    const building = parseElements(
      fixture.osmData.elements,
      fixture.bbox,
      fixture.scale,
    ).buildings[0];
    const footprint = owner.keep(
      new cad.CrossSection(
        [building.polygon.outer, ...building.polygon.holes],
        "EvenOdd",
      ),
    );
    const panels = building.roofSurfaces!;
    assert.equal(panels.length, 69);
    assert.ok(!building.measuredSolid);
    const foundationZ = 2.7;
    const toElevation = (elevation: number) =>
      3 + (elevation - fixture.elevationGrid!.minElev) * sf;
    const solid = makeMeasuredRoof(
      cad,
      owner,
      panels,
      building.groundElevation!,
      projection.project,
      sf,
      1,
      toElevation(building.groundElevation!),
      foundationZ,
      footprint,
      DEFAULT_MODEL_SETTINGS.print.minBuildingHeightMm,
    );
    assert.ok(solid);
    assert.equal(solid.status(), "NoError");
    // Independently integrate horizontal strata. This does not use the roof
    // builder's triangles or its native three-dimensional union order.
    const strata = panels.map((panel) => {
      const elevation = panel.outer[0].elevation;
      assert.ok(
        [panel.outer, ...panel.holes].every((ring) =>
          ring.every((point) => point.elevation === elevation),
        ),
      );
      return {
        z: toElevation(elevation),
        section: owner.keep(
          new cad.CrossSection(
            [panel.outer, ...panel.holes].map((ring) =>
              ring.map(
                (point) =>
                  projection
                    .project(point.lon, point.lat)
                    .map((coordinate) => coordinate * sf) as Point2D,
              ),
            ),
            "EvenOdd",
          ),
        ),
      };
    });
    const levels = [...new Set(strata.map((stratum) => stratum.z))].sort(
      (a, b) => a - b,
    );
    let previous = foundationZ;
    let integratedVolume = 0;
    for (const z of levels) {
      const horizontal = owner.keep(
        cad.CrossSection.union(
          strata
            .filter((stratum) => stratum.z >= z)
            .map((stratum) => stratum.section),
        ),
      );
      const clipped = owner.keep(horizontal.intersect(footprint));
      integratedVolume += clipped.area() * (z - previous);
      previous = z;
    }
    assert.ok(Math.abs(solid.volume() - integratedVolume) < 0.001);
    assert.ok(Math.abs(solid.volume() - 123.89893090848813) < 0.001);
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});

test("Arbre Blanc retains six source terrace levels and its narrow summit in the actual 200 mm city projection", async () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  // The measured-envelope option remains available alongside the separately
  // labelled LiDAR balcony interpretation, whose volume is intentionally lower.
  settings.features.buildings.balconies = false;
  settings.base.topographyEnabled = true;
  settings.base.grid = { rows: 2, cols: 2 };
  const model = await buildPrintModel({ ...fixture, settings });
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.components, 1);
  assert.ok(!model.warnings.some((warning) => /toiture.*repli/i.test(warning)));
  const panels = fixture.osmData.elements[0].roofSurfaces!;
  const projection = createProjectionForBbox(fixture.bbox);
  const sf = 1000 / fixture.scale;
  const toElevation = (elevation: number) =>
    settings.base.basePlateThicknessMm +
    (elevation - fixture.elevationGrid!.minElev) * sf;
  // Fixed interior source triangles at distinct real terrace levels. A uniform
  // extrusion to the top elevation cannot satisfy these independent probes.
  for (const { panel, first, elevation } of [
    { panel: 24, first: 0, elevation: 33.433 },
    { panel: 14, first: 1, elevation: 39.416 },
    { panel: 30, first: 0, elevation: 45.277 },
    { panel: 16, first: 0, elevation: 50.749 },
    { panel: 63, first: 0, elevation: 63.126 },
    { panel: 67, first: 0, elevation: 68.571 },
  ]) {
    const source = panels[panel].outer.slice(first, first + 3);
    assert.ok(source.every((point) => point.elevation === elevation));
    const [x, y] = projection
      .project(
        source.reduce((sum, point) => sum + point.lon, 0) / 3,
        source.reduce((sum, point) => sum + point.lat, 0) / 3,
      )
      .map((coordinate) => coordinate * sf);
    assert.ok(
      Math.abs(upperBuildingSurface(model, x, y) - toElevation(elevation)) <
        0.01,
      `the terrace at ${elevation} m IGN69 retains its source height`,
    );
  }
  assert.ok(Math.abs(model.dimensions.heightMm - toElevation(68.571)) < 0.01);
  const buildingVertices = new Set<number>();
  for (let face = 0; face < model.faceLayers.length; face++)
    if (PRINT_LAYERS[model.faceLayers[face]] === "buildings")
      for (const index of model.indices.subarray(face * 3, face * 3 + 3))
        buildingVertices.add(index);
  const points = [...buildingVertices].map((index) =>
    Array.from(model.positions.subarray(index * 3, index * 3 + 3)),
  );
  const summit = points.filter((point) => point[2] > toElevation(68.5));
  assert.ok(summit.length > 0);
  for (const axis of [0, 1]) {
    const span = (vertices: number[][]) =>
      Math.max(...vertices.map((point) => point[axis])) -
      Math.min(...vertices.map((point) => point[axis]));
    assert.ok(span(summit) < span(points) * 0.15);
  }
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (total, tile) => total + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(volume - tileVolume) / volume < 1e-4);
});
