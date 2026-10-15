import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import observed from "../src/lib/data/arbre-blanc-lidar.json";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { preparePreview } from "../src/lib/mesh/prepare-preview";
import { createProjectionForBbox } from "../src/lib/projection";
import { createSTLBuffer } from "../src/lib/export/stl-export";
import { create3MFBuffer } from "../src/lib/export/threemf-export";
import { geographicPointInRing } from "../src/lib/osm/relation-polygons";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { BBox } from "../src/types/osm";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
  type PrintModel,
  type PrintTile,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

type Interval = { bottom: number; top: number };
const original = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
    "utf8",
  ),
) as Pick<PrintInput, "osmData">;
const scale = 5000;
const sf = 1000 / scale;
const bbox: BBox = [
  observed.bounds[0] - 0.0005,
  observed.bounds[1] - 0.0005,
  observed.bounds[2] + 0.0005,
  observed.bounds[3] + 0.0005,
];
const projection = createProjectionForBbox(bbox);
const baseZ = DEFAULT_MODEL_SETTINGS.base.basePlateThicknessMm;
const toZ = (elevationM: number) => baseZ + elevationM * sf;
const sourceSnapshot = JSON.stringify(original.osmData);
let model: PrintModel;
let envelope: PrintModel;
function input(balconies: boolean): PrintInput {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = { cols: 2, rows: 2 };
  settings.base.topographyEnabled = true;
  settings.base.frame.enabled = false;
  settings.features.buildings.balconies = balconies;
  settings.features.roads.enabled = false;
  settings.features.water.enabled = false;
  settings.features.parks.enabled = false;
  return {
    bbox,
    scale,
    settings,
    osmData: structuredClone(original.osmData),
    // Deliberate synthetic IGN69 control at datum zero, not a sampled DEM.
    // The municipal/LiDAR altitudes and source roof geometry remain untouched.
    elevationGrid: {
      rows: 2,
      cols: 2,
      points: [0, 0, 0, 0],
      minElev: 0,
      maxElev: 0,
      south: bbox[0],
      west: bbox[1],
      north: bbox[2],
      east: bbox[3],
      source: "IGN69 datum · declared synthetic zero-elevation print control",
    },
  };
}

/** Independent vertical ray intersections of the actual oriented boundary.
 * Multiple triangles on the same planar face count as one crossing. */
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
const includes = (values: Interval[], z: number) =>
  values.some((v) => z > v.bottom + 0.00001 && z < v.top - 0.00001);
function witnesses() {
  // Fixed real class-6 returns, not centroids or points selected from the
  // output under test. These contours have a connection to the mapped core;
  // some other returns belong to fragments explicitly omitted for lack of a
  // local support. Acquisition records each point's contour clearance.
  const pointIndices = [0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 1, 2, 5];
  assert.equal(pointIndices.length, observed.levels.length);
  return observed.levels.map((level, at) => ({
    level,
    point: level.verificationPoints[pointIndices[at]],
  }));
}
function printedPoint(point: { lat: number; lon: number }): [number, number] {
  const [x, y] = projection.project(point.lon, point.lat);
  return [x * sf, y * sf];
}
function localPoint(tile: PrintTile, x: number, y: number) {
  return [
    x +
      model.dimensions.widthMm / 2 -
      tile.col * tile.widthMm -
      tile.widthMm / 2,
    y +
      model.dimensions.depthMm / 2 -
      tile.row * tile.depthMm -
      tile.depthMm / 2,
  ];
}
function readSTL(buffer: ArrayBuffer): PrintMesh {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(buffer.byteLength, 84 + 50 * count);
  const positions = new Float32Array(count * 9);
  for (let face = 0; face < count; face++)
    for (let i = 0; i < 9; i++)
      positions[face * 9 + i] = view.getFloat32(
        84 + face * 50 + 12 + i * 4,
        true,
      );
  return {
    positions,
    indices: Uint32Array.from({ length: count * 3 }, (_, i) => i),
    faceLayers: new Uint8Array(count),
  };
}
async function read3MF(mesh: PrintMesh) {
  const zip = await JSZip.loadAsync(
    await create3MFBuffer(mesh, model.colors, model),
  );
  const xml = await zip.file("3D/3dmodel.model")!.async("string");
  const positions: number[] = [],
    indices: number[] = [],
    layers: number[] = [];
  for (const m of xml.matchAll(
    /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g,
  ))
    positions.push(...m.slice(1).map(Number));
  for (const m of xml.matchAll(
    /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="1" p1="(\d+)"\/>/g,
  )) {
    indices.push(...m.slice(1, 4).map(Number));
    layers.push(Number(m[4]));
  }
  assert.match(xml, /unit="millimeter"/);
  assert.ok(
    xml.includes("IGN LiDAR HD"),
    "LiDAR attribution survives the archive",
  );
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    faceLayers: Uint8Array.from(layers),
  };
}

before(async () => {
  const enriched = input(true);
  const snapshot = JSON.stringify(enriched.osmData);
  model = await buildPrintModel(enriched);
  assert.equal(JSON.stringify(enriched.osmData), snapshot);
  envelope = await buildPrintModel(input(false));
});

test("Arbre Blanc keeps a connected physical balcony reconstruction at 1:5000 and IGN69 datum zero", () => {
  assert.equal(observed.levels.length, 17);
  assert.equal(observed.incomplete, true);
  assert.equal(observed.method.undersidesMeasured, false);
  assert.equal(observed.method.slabThicknessMeasured, false);
  assert.equal(model.stats.reconstructedBalconyBuildingCount, 1);
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.components, 1);
  assert.equal(model.tiles.length, 4);
  const volume = assertClosedSolid(model);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 0.0001);
  assert.ok(
    volume < assertClosedSolid(envelope),
    "keeping air under balconies removes the old filled columns",
  );
  assert.ok(
    Math.abs(model.dimensions.heightMm - toZ(68.571)) < 0.005,
    "narrow measured rooftop keeps its absolute IGN69 altitude",
  );
  assert.ok(model.warnings.some((w) => /épaisseur de dalle adaptée/.test(w)));
  assert.ok(
    model.warnings.some((w) =>
      w.includes(
        "Le volume du noyau est reconstitué jusqu’au dernier plateau visible",
      ),
    ),
    "the estimated facade volume is distinguished from the measured rooftop",
  );
  assert.ok(
    model.warnings.some((w) => /sous-faces ne sont pas mesurées/.test(w)),
  );
  assert.ok(
    model.warnings.some((w) =>
      /fragment\(s\) sans appui ou trop petits.*omis/.test(w),
    ),
    "unsupported source fragments are explicitly declared rather than floated",
  );
  assert.ok(
    !model.warnings.some((w) => /balcons.*n’a pas pu être conservée/.test(w)),
  );
  assert.equal(
    model.landmarks
      ?.find((l) => l.representation === "reconstructed-balconies")
      ?.source.includes("IGN LiDAR HD"),
    true,
  );
  assert.equal(JSON.stringify(original.osmData), sourceSnapshot);
});

test("real LiDAR returns outside the OSM core have thin slabs, downward undersides and air instead of columns", () => {
  let checked = 0,
    oldColumns = 0;
  for (const { level, point } of witnesses()) {
    assert.ok(point.clearanceM > 0.6);
    assert.equal(
      geographicPointInRing(point, observed.coreFootprint.outer),
      false,
    );
    assert.ok(
      Math.abs(point.observedElevationM - level.elevationM) <=
        observed.method.halfBandM + 0.00001,
    );
    const [x, y] = printedPoint(point);
    const values = intervals(model, x, y);
    const z = toZ(level.elevationM) - 0.06;
    const slab = values.find((v) => z > v.bottom && z < v.top);
    assert.ok(
      slab,
      `observed level ${level.elevationM}m retains printable material`,
    );
    assert.ok(
      slab.top - slab.bottom < 0.5,
      `level ${level.elevationM}: an actual thin slab, not a vertical extrusion`,
    );
    assert.ok(slab.top >= toZ(level.elevationM) - 0.005);
    const under = slab.bottom - 0.03;
    assert.equal(
      includes(values, under),
      false,
      `level ${level.elevationM} keeps air below its underside`,
    );
    assert.ok(
      slab.bottom > baseZ + 0.1,
      "balcony undersides do not descend to the socle",
    );
    if (includes(intervals(envelope, x, y), under)) oldColumns++;
    let containing = 0;
    for (const tile of model.tiles) {
      const [tx, ty] = localPoint(tile, x, y);
      if (Math.abs(tx) > tile.widthMm / 2 || Math.abs(ty) > tile.depthMm / 2)
        continue;
      const cut = intervals(tile, tx, ty);
      assert.equal(includes(cut, z), true, "same slab material after cutting");
      assert.equal(
        includes(cut, under),
        false,
        "same open underside after cutting",
      );
      containing++;
    }
    assert.ok(containing > 0);
    checked++;
  }
  assert.equal(checked, 17);
  assert.ok(
    oldColumns >= 10,
    "independent probes detect the actual former column failure",
  );
});

test("whole and all four STL/3MF exports preserve physical balcony air and exact millimetre geometry", async () => {
  for (const mesh of [model, ...model.tiles]) {
    const stl = readSTL(createSTLBuffer(mesh));
    const threemf = await read3MF(mesh);
    const expected = assertClosedSolid(mesh);
    assert.ok(Math.abs(assertClosedSolid(stl) - expected) / expected < 0.00001);
    assert.ok(
      Math.abs(assertClosedSolid(threemf) - expected) / expected < 0.00001,
    );
    assert.deepEqual(threemf.positions, mesh.positions);
    assert.deepEqual(threemf.indices, mesh.indices);
    assert.deepEqual(threemf.faceLayers, mesh.faceLayers);
    for (const { level, point } of witnesses()) {
      let [x, y] = printedPoint(point);
      if ("col" in mesh) {
        [x, y] = localPoint(mesh, x, y);
        if (Math.abs(x) > mesh.widthMm / 2 || Math.abs(y) > mesh.depthMm / 2)
          continue;
      }
      const expectedIntervals = intervals(mesh, x, y);
      for (const decoded of [stl, threemf]) {
        const actual = intervals(decoded, x, y);
        assert.equal(actual.length, expectedIntervals.length);
        for (let at = 0; at < actual.length; at++) {
          assert.ok(
            Math.abs(actual[at].bottom - expectedIntervals[at].bottom) <
              0.00001,
          );
          assert.ok(
            Math.abs(actual[at].top - expectedIntervals[at].top) < 0.00001,
          );
        }
        assert.equal(includes(actual, toZ(level.elevationM) - 0.06), true);
      }
    }
  }
});

test("worker preview uses the same balcony triangles and voids as the printable model", () => {
  const preview = preparePreview(model);
  const positions = new Float32Array(preview.positions.length);
  for (let at = 0; at < positions.length; at += 3)
    positions.set(
      [
        preview.positions[at],
        -preview.positions[at + 2],
        preview.positions[at + 1],
      ],
      at,
    );
  const faceLayers = new Uint8Array(preview.indices.length / 3);
  for (const group of preview.groups)
    faceLayers.fill(
      group.materialIndex,
      group.start / 3,
      (group.start + group.count) / 3,
    );
  const restored = { positions, indices: preview.indices, faceLayers };
  assert.ok(new Set(faceLayers).has(PRINT_LAYERS.indexOf("buildings")));
  assert.ok(
    Math.abs(assertClosedSolid(restored) - assertClosedSolid(model)) < 0.00001,
  );
  for (const { point } of witnesses()) {
    const [x, y] = printedPoint(point);
    assert.deepEqual(intervals(restored, x, y), intervals(model, x, y));
  }
});
