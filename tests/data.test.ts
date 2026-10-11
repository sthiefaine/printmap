import test from "node:test";
import assert from "node:assert/strict";
import { assembleRings } from "../src/lib/osm/relation-polygons";
import { parseElements } from "../src/lib/osm/parse-elements";
import {
  parseLengthMeters,
  getBuildingHeight,
} from "../src/lib/osm/building-height";
import { validateBbox } from "../src/lib/data/bbox";
import { validateElevationGrid } from "../src/lib/elevation/validate-grid";
import { enrichWithIGN } from "../src/lib/data/ign-buildings";
import { fetchOverpass } from "../src/lib/data/overpass";
import { selectComplementaryWater } from "../src/lib/data/water-coverage";
import type { BBox, LatLon, OverpassElement } from "../src/types/osm";

const bbox: BBox = [43.6, 3.87, 43.62, 3.89];
const ring: LatLon[] = [
  { lat: 43.61, lon: 3.88 },
  { lat: 43.61, lon: 3.8802 },
  { lat: 43.6102, lon: 3.8802 },
  { lat: 43.6102, lon: 3.88 },
  { lat: 43.61, lon: 3.88 },
];
const hole = ring.map((point) => ({
  lat: 43.61005 + (point.lat - 43.61) / 2,
  lon: 3.88005 + (point.lon - 3.88) / 2,
}));

test("unordered, reversed OSM fragments assemble into a closed ring; incomplete rings stay absent", () => {
  assert.equal(
    assembleRings([
      [ring[2], ring[1]],
      [ring[0], ring[1]],
      [ring[4], ring[3], ring[2]],
    ]).length,
    1,
  );
  assert.equal(
    assembleRings([
      [ring[0], ring[1], ring[2]],
      [ring[2], ring[3]],
    ]).length,
    0,
  );
});

test("multipolygon courtyard survives; relation members and repeated objects are deduplicated", () => {
  const relation: OverpassElement = {
    type: "relation",
    id: 1,
    tags: { building: "yes", height: "12" },
    members: [
      { type: "way", ref: 20, role: "outer", geometry: ring.slice(0, 3) },
      {
        type: "way",
        ref: 21,
        role: "outer",
        geometry: [ring[0], ring[3], ring[2]],
      },
      { type: "way", ref: 22, role: "inner", geometry: hole },
    ],
  };
  const standalone: OverpassElement = {
    type: "way",
    id: 20,
    tags: { building: "yes" },
    geometry: ring,
  };
  const parsed = parseElements([relation, relation, standalone], bbox, 5000);
  assert.equal(parsed.buildings.length, 1);
  assert.equal(parsed.buildings[0].polygon.holes.length, 1);
  assert.ok(Math.abs(parsed.buildings[0].wallHeight - 2.4) < 1e-8);
  assert.equal(parsed.buildings[0].roofShape, "flat");
});

test("open water, parks and piers never gain phantom triangular surfaces", () => {
  const open = ring.slice(0, 4);
  const parsed = parseElements(
    [
      { type: "way", id: 1, tags: { natural: "water" }, geometry: open },
      { type: "way", id: 2, tags: { leisure: "park" }, geometry: open },
      { type: "way", id: 3, tags: { man_made: "pier" }, geometry: open },
      { type: "way", id: 4, tags: { natural: "coastline" }, geometry: open },
    ],
    bbox,
    5000,
  );
  assert.equal(parsed.waterAreas.length, 0);
  assert.equal(parsed.parks.length, 0);
  assert.equal(parsed.piers.length, 0);
  assert.equal(parsed.pierLines.length, 1);
});

test("roads respect measured widths and tunnel/bridge tags; extended green areas are recognised", () => {
  const parsed = parseElements(
    [
      {
        type: "way",
        id: 1,
        tags: { highway: "residential", width: "10", bridge: "yes" },
        geometry: ring.slice(0, 2),
      },
      {
        type: "way",
        id: 2,
        tags: { highway: "primary", layer: "-1" },
        geometry: ring.slice(0, 2),
      },
      { type: "way", id: 3, tags: { landuse: "meadow" }, geometry: ring },
      {
        type: "way",
        id: 4,
        tags: { highway: "construction" },
        geometry: ring.slice(0, 2),
      },
    ],
    bbox,
    5000,
  );
  assert.equal(parsed.roads.length, 2);
  assert.equal(parsed.roads[0].halfWidth, 1);
  assert.equal(parsed.roads[0].isBridge, true);
  assert.equal(parsed.roads[1].isUnderground, true);
  assert.equal(parsed.parks.length, 1);
});

test("height units are explicit and a wide footprint cannot fabricate tall buildings", () => {
  assert.equal(parseLengthMeters("30 ft"), 9.144);
  assert.equal(parseLengthMeters("12,5 m"), 12.5);
  assert.equal(parseLengthMeters("unknown"), null);
  assert.equal(getBuildingHeight({ building: "yes" }, 1000), 9);
  assert.equal(getBuildingHeight({ "building:levels": "3.5" }), 10.5);
});

test("complete building parts replace their envelope, while isolated parts do not remove it", () => {
  const split = (west: number, east: number): LatLon[] => [
    { lat: 43.61, lon: west },
    { lat: 43.61, lon: east },
    { lat: 43.6102, lon: east },
    { lat: 43.6102, lon: west },
    { lat: 43.61, lon: west },
  ];
  const envelope: OverpassElement = {
    type: "way",
    id: 1,
    tags: { building: "yes" },
    geometry: ring,
  };
  const part1: OverpassElement = {
    type: "way",
    id: 2,
    tags: { "building:part": "yes", height: "3" },
    geometry: split(3.88, 3.8801),
  };
  const part2: OverpassElement = {
    type: "way",
    id: 3,
    tags: { "building:part": "yes", height: "12" },
    geometry: split(3.8801, 3.8802),
  };
  assert.equal(
    parseElements([envelope, part1, part2], bbox, 5000).buildings.length,
    2,
  );
  assert.equal(
    parseElements([envelope, part1], bbox, 5000).buildings.length,
    2,
  );
});

test("bbox rejects reversed, polar, undersized and excessive selections", () => {
  assert.deepEqual(validateBbox(bbox), bbox);
  for (const invalid of [
    [43.62, 3.87, 43.6, 3.89],
    [90, 0, 91, 1],
    [43.6, 3.87, 43.600001, 3.870001],
    [43, 3, 44, 4],
    [NaN, 3, 43, 4],
  ])
    assert.throws(() => validateBbox(invalid));
});

test("imported relief rejects missing elevations and normalises bounds from actual data", () => {
  const grid = {
    rows: 2,
    cols: 2,
    points: [10, 11, 12, 13],
    minElev: -99,
    maxElev: 99,
    south: bbox[0],
    west: bbox[1],
    north: bbox[2],
    east: bbox[3],
  };
  assert.equal(validateElevationGrid(grid).minElev, 10);
  assert.equal(validateElevationGrid(grid).maxElev, 13);
  assert.throws(() => validateElevationGrid({ ...grid, points: [10, 11, 12] }));
  assert.throws(() =>
    validateElevationGrid({ ...grid, points: [10, null, 12, 13] }),
  );
});

test("IGN enriches matching OSM instead of duplicating buildings, preserving courtyards for added buildings", () => {
  const osm: OverpassElement = {
    type: "way",
    id: 10,
    tags: { building: "yes" },
    geometry: ring,
  };
  const geoRing = ring.map((p) => [p.lon, p.lat]);
  const ign = {
    id: "batiment.10",
    geometry: {
      type: "Polygon" as const,
      coordinates: [geoRing, hole.map((p) => [p.lon, p.lat])],
    },
    properties: { hauteur: 18 },
  };
  const enriched = enrichWithIGN([osm], [ign]);
  assert.equal(enriched.elements.length, 1);
  assert.equal(enriched.elements[0].tags?.height, "18");
  assert.equal(osm.tags?.height, undefined);
  const added = enrichWithIGN([], [ign]);
  assert.equal(
    parseElements(added.elements, bbox, 5000).buildings[0].polygon.holes.length,
    1,
  );
  const roof: OverpassElement = {
    ...osm,
    tags: { building: "yes", "roof:shape": "gabled", "roof:height": "3" },
  };
  const withRoof = parseElements(
    enrichWithIGN([roof], [ign]).elements,
    bbox,
    5000,
  ).buildings[0];
  assert.ok(Math.abs(withRoof.wallHeight - 3.6) < 1e-8);
  assert.ok(Math.abs(withRoof.roofHeight - 0.6) < 1e-8);
});

test("water tiles fill a selection inside an otherwise missing lake and never fill an OSM island", () => {
  const lake: OverpassElement = {
    type: "relation",
    id: -1,
    tags: { natural: "water", water: "lake" },
    members: [
      { type: "way", role: "outer", geometry: ring },
      { type: "way", role: "inner", geometry: hole },
    ],
  };
  const inside: BBox = [43.61001, 3.88001, 43.61004, 3.88004];
  assert.equal(selectComplementaryWater([], [lake], inside).length, 1);
  assert.equal(
    parseElements([lake], bbox, 5000).waterAreas[0].polygon.holes.length,
    1,
  );
  const detailed: OverpassElement = { ...lake, id: 50 };
  assert.equal(selectComplementaryWater([detailed], [lake], inside).length, 0);
  const coarse = {
    ...lake,
    members: [{ type: "way", role: "outer", geometry: ring }],
  };
  const island: BBox = [43.61006, 3.88006, 43.61012, 3.88012];
  assert.equal(
    selectComplementaryWater([detailed], [coarse], island).length,
    0,
  );
});

test("Overpass HTTP 200 runtime error cannot be accepted as complete data", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify(
        calls === 1
          ? { elements: [], remark: "runtime error: out of memory" }
          : {
              elements: [],
              osm3s: { timestamp_osm_base: "2026-10-11T08:00:00Z" },
            },
      ),
      { status: 200 },
    );
  };
  try {
    const data = await fetchOverpass(bbox, new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(data.remark, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
