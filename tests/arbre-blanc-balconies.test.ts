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
import {
  DEFAULT_MODEL_SETTINGS,
  PRINT_PROFILES,
} from "../src/store/use-scene-store";
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

// Fixed interior points of the authentic 2020 horizontal RoofSurfaces. These
// patches were absent from the earlier LiDAR-only reconstruction, despite
// being present in its unchanged municipal input. Indices refer to the native
// fixture, not the order of triangles produced by the constructor.
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
function allSurfaceProbes() {
  return [
    ...witnesses().map(({ level, point }) => ({
      elevationM: level.elevationM,
      point,
    })),
    ...municipalProbes.map((point) => ({
      elevationM: point.elevationM,
      point,
    })),
  ];
}
function printedPoint(point: { lat: number; lon: number }): [number, number] {
  const [x, y] = projection.project(point.lon, point.lat);
  return [x * sf, y * sf];
}
function localPoint(
  tile: PrintTile,
  x: number,
  y: number,
  parent: PrintModel = model,
) {
  return [
    x +
      parent.dimensions.widthMm / 2 -
      tile.col * tile.widthMm -
      tile.widthMm / 2,
    y +
      parent.dimensions.depthMm / 2 -
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

test("twelve previously discarded municipal terrace patches keep native tops and open undersides in the model and tiles", () => {
  const surfaces = original.osmData.elements[0].roofSurfaces!;
  for (const point of municipalProbes) {
    const surface = surfaces[point.surface];
    assert.ok(
      [surface.outer, ...surface.holes].every((ring) =>
        ring.every((p) => p.elevation === point.elevationM),
      ),
    );
    assert.ok(geographicPointInRing(point, surface.outer));
    assert.equal(
      surface.holes.some((hole) => geographicPointInRing(point, hole)),
      false,
    );
    assert.equal(
      geographicPointInRing(point, observed.coreFootprint.outer),
      false,
    );
    const [x, y] = printedPoint(point);
    const z = toZ(point.elevationM) - 0.06;
    const values = intervals(model, x, y);
    const slab = values.find((v) => z > v.bottom && z < v.top);
    assert.ok(slab, `municipal surface ${point.surface} retains material`);
    assert.ok(Math.abs(slab.top - toZ(point.elevationM)) < 0.005);
    assert.ok(slab.top - slab.bottom < 0.5);
    const under = slab.bottom - 0.03;
    assert.equal(includes(values, under), false);
    assert.equal(includes(intervals(envelope, x, y), under), true);
    let containing = 0;
    for (const tile of model.tiles) {
      const [tx, ty] = localPoint(tile, x, y);
      if (Math.abs(tx) > tile.widthMm / 2 || Math.abs(ty) > tile.depthMm / 2)
        continue;
      const cut = intervals(tile, tx, ty);
      assert.equal(includes(cut, z), true);
      assert.equal(includes(cut, under), false);
      const localSlab = cut.find((v) => z > v.bottom && z < v.top)!;
      assert.ok(Math.abs(localSlab.top - toZ(point.elevationM)) < 0.005);
      containing++;
    }
    assert.ok(containing > 0);
  }
});

test("the exact browser scale and phase retain a nearly tangent municipal terrace and all 29 fixed source witnesses", async () => {
  // Real failing browser selection/normalised scale. The deliberate flat IGN69
  // control retains its exact datum, isolating the XY contact from DEM noise.
  // Surface 38 is only 4e-9 mm from the core at this phase: clamping the unit
  // vector's denominator to 1e-6 discarded a genuine, well-supported terrace.
  const browserBbox: BBox = [43.6025, 3.892, 43.609, 3.901];
  const browserScale = 4997.5784102273765;
  const browserSf = 1000 / browserScale;
  const datum = 6.12;
  const browserInput = input(true);
  browserInput.bbox = browserBbox;
  browserInput.scale = browserScale;
  browserInput.settings.print = { ...PRINT_PROFILES.detail.print };
  browserInput.elevationGrid = {
    rows: 2,
    cols: 2,
    points: [datum, datum, datum, datum],
    minElev: datum,
    maxElev: datum,
    south: browserBbox[0],
    west: browserBbox[1],
    north: browserBbox[2],
    east: browserBbox[3],
    source: "IGN69 datum · declared synthetic browser-phase regression control",
  };
  const browserModel = await buildPrintModel(browserInput);
  assert.equal(browserModel.stats.reconstructedBalconyBuildingCount, 1);
  assert.equal(browserModel.tiles.length, 4);
  assert.ok(
    !browserModel.warnings.some((w) =>
      /balcons.*n’a pas pu être conservée/.test(w),
    ),
    "the source reconstruction must not silently fall back to an extrusion",
  );
  const volume = assertClosedSolid(browserModel);
  const tileVolume = browserModel.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 0.0001);
  const browserProjection = createProjectionForBbox(browserBbox);
  let checked = 0;
  for (const { elevationM, point } of allSurfaceProbes()) {
    const [px, py] = browserProjection.project(point.lon, point.lat);
    const x = px * browserSf,
      y = py * browserSf;
    const expectedTop = baseZ + (elevationM - datum) * browserSf;
    const z = expectedTop - 0.06;
    const values = intervals(browserModel, x, y);
    const slab = values.find((v) => z > v.bottom && z < v.top);
    assert.ok(slab, `source witness ${elevationM}m retains real material`);
    assert.ok(slab.top - slab.bottom < 0.5);
    assert.ok(slab.top >= expectedTop - 0.005);
    if ("surface" in point) assert.ok(Math.abs(slab.top - expectedTop) < 0.005);
    assert.equal(includes(values, slab.bottom - 0.03), false);
    let containing = 0;
    for (const tile of browserModel.tiles) {
      const [tx, ty] = localPoint(tile, x, y, browserModel);
      if (Math.abs(tx) > tile.widthMm / 2 || Math.abs(ty) > tile.depthMm / 2)
        continue;
      const cut = intervals(tile, tx, ty);
      const tileSlab = cut.find((v) => z > v.bottom && z < v.top);
      assert.ok(tileSlab);
      assert.ok(Math.abs(tileSlab.bottom - slab.bottom) < 0.00001);
      assert.ok(Math.abs(tileSlab.top - slab.top) < 0.00001);
      assert.equal(includes(cut, slab.bottom - 0.03), false);
      containing++;
    }
    assert.ok(containing > 0);
    checked++;
  }
  assert.equal(checked, 29);
  assert.equal(JSON.stringify(original.osmData), sourceSnapshot);
});

test("the user's C3 L1 assembly frame retains the balconies without a detached scrap from a clipped connector", async () => {
  // Exact saved assembly-cell frame from the reported 365-building model.
  // Its municipal input is bit-for-bit identical to this native fixture.
  // A connector at 59.469m used to acquire a separate 0.0002677631mm² scrap
  // after clipping against a concave envelope. That inferred scrap overlaps
  // neither source terrace nor core, and must not invalidate the whole tower.
  const assemblyBbox: BBox = [
    43.601407977642914, 3.893206659524327, 43.607928059285825,
    3.9022093950324357,
  ];
  const originLat = 43.594887896;
  const assemblyInput = input(true);
  assemblyInput.bbox = assemblyBbox;
  assemblyInput.assemblyFrame = { originLat, elevationDatumM: 0 };
  assemblyInput.settings.print = { ...PRINT_PROFILES.detail.print };
  // Declared synthetic IGN69 zero terrain isolates the true source and exact
  // assembly projection. The source footprint, all 69 pans and Z stay native.
  assemblyInput.elevationGrid = {
    ...assemblyInput.elevationGrid!,
    south: assemblyBbox[0],
    west: assemblyBbox[1],
    north: assemblyBbox[2],
    east: assemblyBbox[3],
  };
  const retained = await buildPrintModel(assemblyInput);
  assert.equal(retained.stats.reconstructedBalconyBuildingCount, 1);
  assert.equal(retained.stats.buildingCount, 1);
  assert.equal(retained.stats.components, 1);
  assert.ok(
    retained.landmarks?.some(
      (landmark) => landmark.representation === "reconstructed-balconies",
    ),
  );
  assert.ok(
    !retained.warnings.some((w) =>
      /balcons.*n’a pas pu être conservée/.test(w),
    ),
  );
  const volume = assertClosedSolid(retained);
  const tileVolume = retained.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.equal(retained.tiles.length, 4);
  assert.ok(Math.abs(tileVolume - volume) / volume < 0.0001);
  const assemblyProjection = createProjectionForBbox(assemblyBbox, originLat);
  let checked = 0;
  for (const { elevationM, point } of allSurfaceProbes()) {
    const [px, py] = assemblyProjection.project(point.lon, point.lat);
    const x = px * sf,
      y = py * sf;
    const expectedTop = toZ(elevationM);
    const z = expectedTop - 0.06;
    const values = intervals(retained, x, y);
    const slab = values.find((v) => z > v.bottom && z < v.top);
    assert.ok(slab, `C3 L1 source witness ${elevationM}m retains material`);
    assert.ok(slab.top - slab.bottom < 0.5);
    assert.ok(slab.top >= expectedTop - 0.005);
    if ("surface" in point) assert.ok(Math.abs(slab.top - expectedTop) < 0.005);
    assert.equal(includes(values, slab.bottom - 0.03), false);
    let containing = 0;
    for (const tile of retained.tiles) {
      const [tx, ty] = localPoint(tile, x, y, retained);
      if (Math.abs(tx) > tile.widthMm / 2 || Math.abs(ty) > tile.depthMm / 2)
        continue;
      const cut = intervals(tile, tx, ty);
      const tileSlab = cut.find((v) => z > v.bottom && z < v.top);
      assert.ok(tileSlab);
      assert.ok(Math.abs(tileSlab.bottom - slab.bottom) < 0.00001);
      assert.ok(Math.abs(tileSlab.top - slab.top) < 0.00001);
      assert.equal(includes(cut, slab.bottom - 0.03), false);
      containing++;
    }
    assert.ok(containing > 0);
    checked++;
  }
  assert.equal(checked, 29);
  assert.equal(JSON.stringify(original.osmData), sourceSnapshot);
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
    for (const { elevationM, point } of allSurfaceProbes()) {
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
        assert.equal(includes(actual, toZ(elevationM) - 0.06), true);
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
  for (const { point } of allSurfaceProbes()) {
    const [x, y] = printedPoint(point);
    assert.deepEqual(intervals(restored, x, y), intervals(model, x, y));
  }
});
