import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import { isArbreBlanc, makeArbreBlanc } from "../src/lib/mesh/arbre-blanc";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import type { PrintInput, PrintMesh } from "../src/types/print";
import observed from "../src/lib/data/arbre-blanc-lidar.json";
import type { Point2D } from "../src/types/geometry";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "osmData" | "bbox">;

type Interval = { bottom: number; top: number };
function intervals(mesh: PrintMesh, x: number, y: number): Interval[] {
  const crossings: Array<{ z: number; direction: number }> = [];
  const p = mesh.positions;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const a = mesh.indices[at] * 3,
      b = mesh.indices[at + 1] * 3,
      c = mesh.indices[at + 2] * 3;
    const determinant =
      (p[b] - p[a]) * (p[c + 1] - p[a + 1]) -
      (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (Math.abs(determinant) < 1e-12) continue;
    const u =
      ((x - p[a]) * (p[c + 1] - p[a + 1]) - (y - p[a + 1]) * (p[c] - p[a])) /
      determinant;
    const v =
      ((p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a])) /
      determinant;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
    crossings.push({
      z: p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]),
      direction: Math.sign(determinant),
    });
  }
  crossings.sort((a, b) => a.z - b.z);
  const planes: Array<{ z: number; up: boolean; down: boolean }> = [];
  for (const crossing of crossings) {
    let plane = planes.at(-1);
    if (!plane || Math.abs(plane.z - crossing.z) > 0.00001) {
      plane = { z: crossing.z, up: false, down: false };
      planes.push(plane);
    }
    if (crossing.direction > 0) plane.up = true;
    else plane.down = true;
  }
  const result: Interval[] = [];
  let bottom: number | undefined;
  for (const plane of planes) {
    if (plane.down && !plane.up) bottom = plane.z;
    else if (plane.up && !plane.down && bottom != null) {
      result.push({ bottom, top: plane.z });
      bottom = undefined;
    }
  }
  return result;
}

// Same frozen twelve native source witnesses as the export regression.
const municipalProbes = [
  { surface: 18, elevationM: 59.469, lat: 43.605664531, lon: 3.898074662 },
  { surface: 21, elevationM: 50.749, lat: 43.605941197, lon: 3.898316667 },
  { surface: 26, elevationM: 50.809, lat: 43.606057505, lon: 3.898249804 },
  { surface: 38, elevationM: 50.631, lat: 43.606062165, lon: 3.89806721 },
  { surface: 42, elevationM: 56.304, lat: 43.605890552, lon: 3.898262053 },
  { surface: 43, elevationM: 50.824, lat: 43.605904186, lon: 3.898269443 },
  { surface: 45, elevationM: 45.094, lat: 43.605800802, lon: 3.898228125 },
  { surface: 49, elevationM: 45.201, lat: 43.605839052, lon: 3.898236193 },
  { surface: 52, elevationM: 50.749, lat: 43.605686345, lon: 3.898213405 },
  { surface: 55, elevationM: 42.349, lat: 43.605665161, lon: 3.898136116 },
  { surface: 57, elevationM: 56.304, lat: 43.605709886, lon: 3.898224403 },
  { surface: 60, elevationM: 51.411, lat: 43.605827472, lon: 3.897890894 },
];

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
  let referenceSource: number[] | undefined;
  const fixed = [0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 1, 2, 5];
  const probes = [
    ...observed.levels.map((level, index) => ({
      ...level.verificationPoints[fixed[index]],
      elevationM: level.elevationM,
    })),
    ...municipalProbes,
  ];
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
      // Restoring nearly tangent source patches exposes one precision contact
      // at X=0. Its 5µm opening removes 0.000001012665 mm³; total conversion
      // deltas at these three fixed poses stay below 0.0003 mm³. The previous
      // zero-cut assertion described the incomplete terrace reconstruction.
      assert.ok(result.repairedContactCount <= 1);
      assert.ok(Math.abs(result.repairVolumeDeltaMm3) < 0.0003);
      const sourceCounts = [
        result.retainedLevelCount,
        result.terraceCount,
        result.municipalTerraceCount,
        result.inferredConnectionCount,
        result.omittedFragmentCount,
      ];
      if (referenceSource) assert.deepEqual(sourceCounts, referenceSource);
      referenceSource = sourceCounts;
      const printMesh: PrintMesh = {
        positions: mesh.vertProperties,
        indices: mesh.triVerts,
        faceLayers: new Uint8Array(mesh.triVerts.length / 3),
      };
      for (const point of probes) {
        const [px, py] = projection.project(point.lon, point.lat);
        const x = px * sf - originX + offset,
          y = py * sf - originY;
        const expectedTop = 3 + point.elevationM * sf;
        const z = expectedTop - 0.06;
        const values = intervals(printMesh, x, y);
        const slab = values.find((v) => z > v.bottom && z < v.top);
        assert.ok(slab, `X=${offset}: source witness ${point.elevationM}m`);
        assert.ok(slab.top - slab.bottom < 0.5);
        assert.ok(slab.top >= expectedTop - 0.005);
        if ("surface" in point)
          assert.ok(Math.abs(slab.top - expectedTop) < 0.005);
        assert.ok(
          !values.some(
            (v) => slab.bottom - 0.03 > v.bottom && slab.bottom - 0.03 < v.top,
          ),
          "a numerical contact correction must preserve open undersides",
        );
      }
      assert.equal(probes.length, 29);
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
