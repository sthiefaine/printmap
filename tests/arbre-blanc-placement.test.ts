import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import { isArbreBlanc, makeArbreBlanc } from "../src/lib/mesh/arbre-blanc";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import type { PrintInput } from "../src/types/print";
import type { Point2D } from "../src/types/geometry";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "osmData" | "bbox">;

test("the derived Arbre Blanc stays closed at three positions in a 145 mm assembly plate", async () => {
  const cad = await Module();
  cad.setup();
  const scale = 5000,
    sf = 1000 / scale;
  const projection = createProjectionForBbox(fixture.bbox, 43.6074);
  const building = parseElements(
    fixture.osmData.elements,
    fixture.bbox,
    scale,
    43.6074,
  ).buildings[0];
  assert.ok(isArbreBlanc(building.sourceId));
  assert.ok(isArbreBlanc("way/441634682"));
  assert.ok(!isArbreBlanc(undefined));
  assert.ok(!isArbreBlanc("MMM/B1025580"));
  const xs = building.polygon.outer.map(([x]) => x),
    ys = building.polygon.outer.map(([, y]) => y);
  const originX = (Math.min(...xs) + Math.max(...xs)) / 2,
    originY = (Math.min(...ys) + Math.max(...ys)) / 2;
  let referenceVolume: number | undefined;
  for (const offset of [-65, 0, 65]) {
    const handles: { delete(): void }[] = [];
    const arena = {
      keep<T extends { delete(): void }>(handle: T): T {
        handles.push(handle);
        return handle;
      },
    };
    try {
      const move = ([x, y]: Point2D): Point2D => [
        x - originX + offset,
        y - originY,
      ];
      const footprint = arena.keep(
        new cad.CrossSection(
          [building.polygon.outer, ...building.polygon.holes].map((ring) =>
            ring.map(move),
          ),
          "EvenOdd",
        ),
      );
      const clip = arena.keep(cad.CrossSection.square([145, 145], true));
      const result = makeArbreBlanc(cad, arena, {
        surfaces: building.roofSurfaces!,
        groundElevation: building.groundElevation!,
        project: (lon, lat) => {
          const [x, y] = projection.project(lon, lat);
          return [x + (-originX + offset) / sf, y - originY / sf];
        },
        scaleFactor: sf,
        buildingScale: 1,
        surfaceZ: 3 + building.groundElevation! * sf,
        foundationZ: 2.7,
        footprint,
        clip,
        minimumHeight: 0.35,
        minFeatureMm: 0.45,
      });
      assert.ok(result, `the same source is retained at X=${offset} mm`);
      const mesh = result.solid.getMesh();
      const volume = assertClosedSolid({
        positions: mesh.vertProperties,
        indices: mesh.triVerts,
        faceLayers: new Uint8Array(mesh.triVerts.length / 3),
      });
      assert.equal(result.retainedLevelCount, 17);
      assert.equal(
        result.repairedContactCount,
        0,
        "these three plate placements need no contact cut",
      );
      assert.equal(result.bodyTopElevationM, 62.75);
      assert.equal(result.estimatedBody, true);
      assert.ok(
        Math.abs(result.solid.boundingBox().max[2] - (3 + 68.571 * sf)) < 0.001,
      );
      assert.ok(
        result.solid.boundingBox().min[0] >= -72.5 &&
          result.solid.boundingBox().max[0] <= 72.5,
      );
      assert.ok(
        Math.abs(result.repairVolumeDeltaMm3) <= volume * 0.0001 + 0.00001,
      );
      if (referenceVolume != null)
        assert.ok(
          Math.abs(referenceVolume - volume) / referenceVolume < 0.0001,
          "moving the plate origin does not change the source volume beyond its unchanged precision budget",
        );
      referenceVolume = volume;
    } finally {
      for (const handle of handles.reverse()) handle.delete();
    }
  }
});
