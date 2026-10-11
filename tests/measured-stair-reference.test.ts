import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMeasuredStairReference } from "../src/lib/mesh/measured-stair-reference";
import { parseElements, type BuildingData, type RoadData } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import { makeStairFlight } from "../src/lib/mesh/stair-solid";
import Module from "manifold-3d";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/montpellier-peyrou-stair-reference.json", import.meta.url), "utf8")) as {
  bbox: BBox; elements: OverpassElement[]; terrainGrid: ElevationGrid;
};
const sf = 1000 / 1824.8671371451785, base = 3;
const projection = createProjectionForBbox(fixture.bbox);
const projectMm = (lon: number, lat: number): [number, number] => {
  const [x, y] = projection.project(lon, lat);
  return [x * sf, y * sf];
};
const parsed = parseElements(fixture.elements, fixture.bbox, 1000 / sf);
const toPrintElevation = (_building: BuildingData, elevation: number) => base + (elevation - fixture.terrainGrid.minElev) * sf;
const terrainAt = (x: number, y: number) => {
  const [lon, lat] = projection.unproject(x / sf, y / sf), g = fixture.terrainGrid;
  const cx = Math.max(0, Math.min(g.cols - 1, (lon - g.west) / (g.east - g.west) * (g.cols - 1)));
  const ry = Math.max(0, Math.min(g.rows - 1, (lat - g.south) / (g.north - g.south) * (g.rows - 1)));
  const col = Math.min(g.cols - 2, Math.floor(cx)), row = Math.min(g.rows - 2, Math.floor(ry));
  const u = cx - col, v = ry - row, i = row * g.cols + col;
  const z = (at: number) => Math.fround(base + (g.points[at] - g.minElev) * sf);
  return u + v <= 1
    ? z(i) + u * (z(i + 1) - z(i)) + v * (z(i + g.cols) - z(i))
    : z(i + g.cols + 1) + (1 - v) * (z(i + 1) - z(i + g.cols + 1)) + (1 - u) * (z(i + g.cols) - z(i + g.cols + 1));
};
const reference = (road: RoadData, buildings = parsed.buildings, maxSnapM = 0) =>
  buildMeasuredStairReference(road, buildings, projectMm, toPrintElevation, {scaleFactor: sf, fallbackSurfaceAt: terrainAt, maxSnapM});

test("real Peyrou landings use the measured terrace and retain the uncovered lower DEM landing", async () => {
  const cad = await Module(); cad.setup();
  const handles: Array<{delete(): void}> = [];
  const arena = {keep<T extends {delete(): void}>(handle: T): T {handles.push(handle); return handle;}};
  const clip = arena.keep(cad.CrossSection.square([1000, 1000], true));
  try {
    for (const road of parsed.roads) {
      const ref = reference(road);
      assert.ok(ref);
      const north = road.sourceId === "way/25938157";
      assert.equal(ref.start.kind, north ? "terrain" : "measured");
      assert.equal(ref.end.kind, north ? "measured" : "terrain");
      assert.equal(ref.sourceId, "MMM/B145523");
      assert.equal(ref.year, 2020);
      assert.ok(Math.abs((north ? ref.end : ref.start).sourceElevationM! - 57.774) < 1e-7);
      const lower = north ? ref.start : ref.end;
      const lowerM = fixture.terrainGrid.minElev + (lower.printElevationMm - base) / sf;
      assert.ok(Math.abs(lowerM - (north ? 54.1829248 : 53.4575016)) < 1e-5);
      assert.equal(Math.sign(ref.measuredDeltaMm), north ? 1 : -1);
      const flight = makeStairFlight(cad, arena, road, {
        scaleFactor: sf, halfWidth: road.halfWidth, minTreadMm: .8, minRiserMm: .12,
        foundationZ: 2.7, terrainMaxZ: 30, surfaceAt: ref.surfaceAt, hasElevation: true, clip,
      });
      assert.ok(flight, `measured landing should recover ${road.sourceId}`);
      assert.equal(flight.sourceSteps, north ? 23 : 24);
      assert.equal(flight.solid.status(), "NoError");
      assert.ok(flight.solid.volume() > 0);
    }
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});

test("the measured field interpolates ramp faces, preserves the terrace hole and never reads roofs", () => {
  const road = parsed.roads.find(r => r.sourceId === "way/25938157")!;
  const ref = reference(road)!;
  const surfaces = parsed.buildings[0].measuredSolid!.surfaces;
  const ramp = surfaces.find(s => s.kind === "outerFloor" && s.outer.length === 4)!;
  const triangle = ramp.outer.slice(0, 3);
  const lon = triangle.reduce((sum, p) => sum + p.lon, 0) / 3;
  const lat = triangle.reduce((sum, p) => sum + p.lat, 0) / 3;
  const expected = triangle.reduce((sum, p) => sum + p.elevation, 0) / 3;
  const point = projectMm(lon, lat);
  assert.ok(Math.abs(ref.sourceElevationAt(...point)! - expected) < 1e-6);
  assert.ok(Number.isFinite(ref.surfaceAt(...point)));
  const terrace = surfaces.find(s => s.kind === "outerFloor" && s.holes.length)!;
  assert.ok(ref.walkablePolygons.some(p => p.holes.length === 1));
  const hole = terrace.holes[0];
  const holePoint = projectMm(hole.reduce((sum,p) => sum+p.lon,0)/hole.length, hole.reduce((sum,p) => sum+p.lat,0)/hole.length);
  assert.equal(ref.sourceElevationAt(...holePoint), null);
  assert.equal(ref.surfaceAt(...holePoint), terrainAt(...holePoint));
  const roofs = parsed.buildings.map(b => ({...b, measuredSolid: {...b.measuredSolid!, surfaces: b.measuredSolid!.surfaces.map(s => ({...s, kind: "roof" as const}))}}));
  assert.equal(reference(road, roofs), null);
});

test("optional snapping is bounded and declared; inconsistent directions or distant floors are rejected", () => {
  const north = parsed.roads.find(r => r.sourceId === "way/25938157")!;
  assert.equal(reference(north, parsed.buildings, 2)!.start.kind, "terrain");
  const snapped = reference(north, parsed.buildings, 3.2)!;
  assert.equal(snapped.start.kind, "snapped");
  assert.ok(Math.abs(snapped.start.sourceElevationM! - 54.907) < 1e-7);
  assert.ok(snapped.start.snap!.distanceM > 3.18 && snapped.start.snap!.distanceM < 3.2);
  assert.equal(reference({...north, tags: {...north.tags, incline: "down"}}), null);
  assert.equal(reference({...north, polyline: north.polyline.map(([x,y]) => [x+500,y+500])}), null);
});
