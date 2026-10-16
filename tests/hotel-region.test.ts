import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { type Manifold, type ManifoldToplevel } from "manifold-3d";
import earcut from "earcut";
import JSZip from "jszip";
import type { BBox, OverpassElement } from "../src/types/osm";
import { PRINT_LAYERS, type PrintMesh, type PrintModel } from "../src/types/print";
import { createProjectionForBbox } from "../src/lib/projection";
import { makeMeasuredRoof } from "../src/lib/mesh/roof-solid";
import { applyHotelRegionFacade, isHotelRegion } from "../src/lib/mesh/hotel-region";
import { contractShortEdges } from "../src/lib/mesh/contract-short-edges";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { repairNumericalTriangles } from "../src/lib/mesh/repair-numerical-triangles";
import { createSTLBuffer } from "../src/lib/export/stl-export";
import { create3MFBuffer } from "../src/lib/export/threemf-export";
import { assertClosedSolid } from "./helpers/solid";

const building = JSON.parse(
  readFileSync(new URL("./fixtures/montpellier-hotel-region-roofs.json", import.meta.url), "utf8"),
) as OverpassElement;
const surfaces = building.roofSurfaces!;
const bbox: BBox = [43.601407977642914, 3.893206659524327, 43.607928059285825, 3.9022093950324357];
let cad: ManifoldToplevel;
before(async () => { cad = await Module(); cad.setup(); });

function mesh(solid: Manifold): PrintMesh {
  const raw = solid.getMesh();
  const positions = new Float32Array(raw.vertProperties.length / raw.numProp * 3);
  for (let i = 0; i < positions.length / 3; i++)
    positions.set(raw.vertProperties.subarray(i * raw.numProp, i * raw.numProp + 3), i * 3);
  return { positions, indices: raw.triVerts, faceLayers: new Uint8Array(raw.triVerts.length / 3).fill(1) };
}
function setup(scale = 5000, shift = 0) {
  const handles: { delete(): void }[] = [];
  const owner = { keep<T extends { delete(): void }>(value: T): T { handles.push(value); return value; } };
  const sf = 1000 / scale;
  const baseProject = createProjectionForBbox(bbox, 43.594887896).project;
  const project = (lon: number, lat: number): [number, number] => {
    const p = baseProject(lon, lat);
    return [p[0] + shift / sf, p[1]];
  };
  const footprint = owner.keep(new cad.CrossSection(building.members!.map((member) =>
    member.geometry!.map((point): [number, number] => { const p = project(point.lon, point.lat); return [p[0] * sf, p[1] * sf]; }),
  ), "EvenOdd"));
  const clip = owner.keep(cad.CrossSection.square([400, 400], true));
  const options = {
    sourceId: building.tags!["printmap:source_id"],
    osmId: building.tags!["printmap:osm_id"],
    surfaces,
    groundElevation: building.groundElevation!,
    project,
    scaleFactor: sf,
    buildingScale: 1,
    surfaceZ: 3 + building.groundElevation! * sf,
    minFeatureMm: 0.8,
    clip,
  };
  const raw = makeMeasuredRoof(cad, owner, surfaces, options.groundElevation, project, sf, 1, options.surfaceZ, 2.7, footprint, 0.6)!;
  // The facade receives the existing validated envelope, after the same bounded
  // source cleanup used by the builder. The raw panel union itself has source
  // seams unrelated to these two new rectangular reliefs.
  const rounded = owner.keep(new cad.Manifold(contractShortEdges(cad, raw.getMesh(), 0.001)));
  const simplified = owner.keep(rounded.simplify(0.001));
  const source = owner.keep(new cad.Manifold(repairNumericalTriangles(cad, repairCollinear(cad, repairCoincident(cad, simplified.getMesh())))));
  assertClosedSolid(mesh(source));
  return { owner, source, options, dispose: () => { for (const h of handles.reverse()) h.delete(); } };
}

/** Intersect a horizontal ray perpendicular to the window-width direction. */
function across(mesh: PrintMesh, axis: [number, number], along: number, height: number) {
  const normal = [-axis[1], axis[0]];
  const hits: number[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (id) => {
      const [x, y, z] = mesh.positions.subarray(id * 3, id * 3 + 3);
      return [x * axis[0] + y * axis[1], z, x * normal[0] + y * normal[1]];
    });
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-10) continue;
    const u = ((along - a[0]) * (c[1] - a[1]) - (height - a[1]) * (c[0] - a[0])) / d;
    const v = ((b[0] - a[0]) * (height - a[1]) - (b[1] - a[1]) * (along - a[0])) / d;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      hits.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return [...new Set(hits.map((p) => Number(p.toFixed(5))))].sort((a, b) => a - b);
}
function verticalTop(mesh: PrintMesh, x: number, y: number) {
  let result = -Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (id) => Array.from(mesh.positions.subarray(id * 3, id * 3 + 3)));
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-10) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / d;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / d;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      result = Math.max(result, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return result;
}
function stl(buffer: ArrayBuffer): PrintMesh {
  const view = new DataView(buffer), count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) for (let j = 0; j < 9; j++) positions[i * 9 + j] = view.getFloat32(84 + i * 50 + 12 + j * 4, true);
  return { positions, indices: Uint32Array.from({ length: count * 3 }, (_, i) => i), faceLayers: new Uint8Array(count).fill(1) };
}

test("documented closed glazing is recessed on both actual facades without changing any of the four municipal roofs", () => {
  const { source, options, owner, dispose } = setup();
  try {
    const relief = applyHotelRegionFacade(cad, owner, source, options);
    assert.ok(relief);
    assert.equal(relief.recessCount, 2);
    assert.equal(relief.interpreted, true);
    assert.equal(relief.widthMm, 1.6);
    assert.equal(relief.heightMm, 4.2);
    assert.ok(Math.abs(relief.depthMm - 0.3) < 1e-9);
    const before = mesh(source), after = mesh(relief.solid);
    assertClosedSolid(after);
    const u = relief.center[0] * relief.axis[0] + relief.center[1] * relief.axis[1];
    for (const fraction of [0.1, 0.5, 0.9]) {
      const z = relief.bottomZMm + relief.heightMm * fraction;
      const a = across(before, relief.axis, u, z), b = across(after, relief.axis, u, z);
      assert.equal(a.length, 2); assert.equal(b.length, 2);
      assert.ok(Math.abs(b[0] - a[0] - relief.depthMm) < 0.002, "first facade is recessed");
      assert.ok(Math.abs(a[1] - b[1] - relief.depthMm) < 0.002, "opposite facade is recessed");
      assert.ok(b[1] - b[0] >= relief.minimumCentralWallMm, "the glass remains a thick closed wall, never a tunnel");
    }
    for (const z of [relief.bottomZMm - 0.1, relief.topZMm + 0.1])
      assert.deepEqual(across(after, relief.axis, u, z), across(before, relief.axis, u, z), "ground footprint and upper facade are untouched");
    for (const panel of surfaces) {
      const points: number[] = [], holes: number[] = []; let count = 0;
      for (const [i, ring] of [panel.outer, ...panel.holes].entries()) {
        if (i) holes.push(count);
        for (const p of ring.slice(0, -1)) { const q = options.project(p.lon, p.lat); points.push(q[0] * options.scaleFactor, q[1] * options.scaleFactor); count++; }
      }
      const triangles = earcut(points, holes, 2); let largest = -1, chosen: number[] = [];
      for (let i = 0; i < triangles.length; i += 3) {
        const t = triangles.slice(i, i + 3), [a, b, c] = t.map((j) => [points[j * 2], points[j * 2 + 1]]);
        const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if (area > largest) { largest = area; chosen = t; }
      }
      const x = chosen.reduce((sum, j) => sum + points[j * 2], 0) / 3, y = chosen.reduce((sum, j) => sum + points[j * 2 + 1], 0) / 3;
      assert.ok(Math.abs(verticalTop(after, x, y) - (3 + panel.outer[0].elevation * options.scaleFactor)) < 0.002, `source roof ${panel.outer[0].elevation} m is unchanged`);
      assert.ok(Math.abs(verticalTop(after, x, y) - verticalTop(before, x, y)) < 0.00001);
    }
    assert.match(relief.warnings.join(" "), /profondeur estimées/);
    assert.match(relief.sources.join(" "), /pds\/1222/);
  } finally { dispose(); }
});

test("real facade relief survives actual CAD clipping and STL/3MF export with closed glazing", async () => {
  const { source, options, owner, dispose } = setup();
  try {
    const relief = applyHotelRegionFacade(cad, owner, source, options)!;
    assert.ok(relief);
    const after = mesh(relief.solid), volume = assertClosedSolid(after);
    const bounds = relief.solid.boundingBox();
    const mid = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
    let total = 0;
    const solids = [relief.solid];
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const lo = [col ? mid[0] : bounds.min[0] - 1, row ? mid[1] : bounds.min[1] - 1];
      const hi = [col ? bounds.max[0] + 1 : mid[0], row ? bounds.max[1] + 1 : mid[1]];
      const cutter = owner.keep(owner.keep(cad.Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], bounds.max[2] + 2])).translate([lo[0], lo[1], 0]));
      const tile = owner.keep(relief.solid.intersect(cutter));
      total += assertClosedSolid(mesh(tile)); solids.push(tile);
    }
    assert.ok(Math.abs(total - volume) / volume < 1e-5);
    const colors = Object.fromEntries(PRINT_LAYERS.map((layer) => [layer, "#888888"])) as PrintModel["colors"];
    for (const solid of solids) {
      const decoded = stl(createSTLBuffer(mesh(solid)));
      assertClosedSolid(decoded);
      const xml = await (await JSZip.loadAsync(await create3MFBuffer(mesh(solid), colors, { sources: relief.sources, fetchedAt: "2026-10-16T13:00:00Z" }))).file("3D/3dmodel.model")!.async("string");
      assert.match(xml, /pds\/1222/);
      const positions = Array.from(xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)).flatMap((m) => m.slice(1).map(Number));
      const indices = Array.from(xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)).flatMap((m) => m.slice(1).map(Number));
      assertClosedSolid({ positions: new Float32Array(positions), indices: new Uint32Array(indices), faceLayers: new Uint8Array(indices.length / 3) });
      // Each exported full/tile volume keeps the same clipped relief geometry.
      assert.ok(Math.abs(assertClosedSolid(decoded) - solid.volume()) / solid.volume() < 1e-5);
    }
  } finally { dispose(); }
});

test("source identity, geographical bounds, scale and central-wall guards prevent unrelated or through-cut facades", () => {
  const { source, options, owner, dispose } = setup();
  try {
    assert.equal(isHotelRegion("MMM/B102810", "way/283339491"), true);
    assert.equal(isHotelRegion("MMM/B102810", "way/1"), false);
    assert.equal(isHotelRegion("MMM/B102558"), false);
    assert.equal(applyHotelRegionFacade(cad, owner, source, { ...options, sourceId: "MMM/B102558" }), null);
    const moved = structuredClone(surfaces); moved[0].outer[0].lat += 0.001;
    assert.equal(applyHotelRegionFacade(cad, owner, source, { ...options, surfaces: moved }), null);
    assert.equal(applyHotelRegionFacade(cad, owner, source, { ...options, minFeatureMm: 100 }), null);
    assert.equal(applyHotelRegionFacade(cad, owner, source, { ...options, scaleFactor: 0 }), null);
    assert.equal(applyHotelRegionFacade(cad, owner, source, { ...options, buildingScale: 0 }), null);
  } finally { dispose(); }
});

test("documentary facade remains bounded at other model scales and XY origins", () => {
  for (const [scale, shift] of [[2000, 0], [5000, -65], [5000, 65], [8534, 0]]) {
    const { source, options, owner, dispose } = setup(scale, shift);
    try {
      const result = applyHotelRegionFacade(cad, owner, source, options);
      assert.ok(result, `${scale}/${shift}`);
      assertClosedSolid(mesh(result.solid));
      assert.ok(result.depthMm >= 0.24 && result.depthMm <= 0.4);
      assert.ok(result.solid.volume() < source.volume());
      assert.equal(result.recessCount, 2);
    } finally { dispose(); }
  }
});
