import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOverpassQuery, fetchOverpass } from "../src/lib/data/overpass";
import { summarizePointLandmarks } from "../src/lib/data/point-landmarks";
import { validateImportedElements } from "../src/lib/data/validate-imported-elements";
import { parseElements } from "../src/lib/osm/parse-elements";
import type { BBox, OverpassElement } from "../src/types/osm";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-three-graces-point.json", import.meta.url),
    "utf8",
  ),
) as { source: string; license: string; elements: OverpassElement[] };
const bbox: BBox = [43.608, 3.8791, 43.6088, 3.8801];
const fountain = fixture.elements[0];

test("Overpass collects fountains and physical sculpture landmarks as nodes, ways and relations", () => {
  const query = buildOverpassQuery(bbox);
  const bounds = `(${bbox.join(",")});`;
  assert.ok(query.includes(`nwr["amenity"="fountain"]${bounds}`));
  assert.ok(
    query.includes(
      `nwr["tourism"="artwork"]["artwork_type"~"^(statue|sculpture)$"]${bounds}`,
    ),
  );
  assert.ok(query.includes(`nwr["historic"="monument"]${bounds}`));
  assert.ok(
    query.includes(
      `nwr["historic"="memorial"]["memorial"!~"^(plaque|stolperstein)$"]${bounds}`,
    ),
  );
  assert.ok(!query.includes(`nwr["tourism"="artwork"]${bounds}`));
});

test("real Trois Grâces node is preserved and named as lacking printable geometry", async () => {
  const originalFetch = globalThis.fetch;
  const response = { elements: fixture.elements };
  globalThis.fetch = async () => Response.json(response);
  try {
    const collected = await fetchOverpass(bbox, new AbortController().signal);
    assert.deepEqual(collected.elements, fixture.elements);
    assert.equal(collected.elements[0].lat, 43.6084697);
    assert.equal(collected.elements[0].lon, 3.8795);
    validateImportedElements(collected.elements);
    const before = structuredClone(collected.elements);
    const report = summarizePointLandmarks(collected.elements, bbox);
    assert.equal(report.pointLandmarkCount, 1);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /Fontaine des Trois Grâces/);
    assert.match(report.warnings[0], /uniquement localisé par un point/);
    assert.match(report.warnings[0], /Aucune géométrie 3D/);
    assert.match(report.warnings[0], /ne sont pas reconstruits/);
    assert.deepEqual(collected.elements, before);
    const parsed = parseElements(collected.elements, bbox, 5000);
    for (const value of Object.values(parsed))
      if (Array.isArray(value)) assert.equal(value.length, 0);
    assert.match(fixture.source, /4324886075/);
    assert.match(fixture.license, /OpenStreetMap contributors.*ODbL/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("point warnings exclude plaques, nonphysical art, outside points and actual polygon basins", () => {
  const elements: OverpassElement[] = [
    fountain,
    fountain,
    { ...fountain, id: 2, tags: { historic: "memorial", memorial: "plaque" } },
    {
      ...fountain,
      id: 3,
      tags: { historic: "memorial", memorial: "stolperstein" },
    },
    {
      ...fountain,
      id: 4,
      tags: { tourism: "artwork", artwork_type: "mural" },
    },
    { ...fountain, id: 5, lat: 43.7 },
    {
      ...fountain,
      type: "way",
      id: 6,
      geometry: [
        { lat: 43.6084, lon: 3.8794 },
        { lat: 43.6084, lon: 3.8796 },
        { lat: 43.6086, lon: 3.8796 },
        { lat: 43.6086, lon: 3.8794 },
        { lat: 43.6084, lon: 3.8794 },
      ],
      tags: { amenity: "fountain", natural: "water", water: "basin" },
    },
  ];
  const report = summarizePointLandmarks(elements, bbox);
  assert.equal(report.pointLandmarkCount, 1);
  assert.equal(report.warnings.length, 1);
  assert.equal(parseElements(elements, bbox, 5000).waterAreas.length, 1);
});

test("many missing landmarks produce a bounded warning without constructing point geometry", () => {
  const elements: OverpassElement[] = Array.from(
    { length: 80 },
    (_, index) => ({
      ...fountain,
      id: index,
      tags: { historic: "memorial", name: `Mémorial ${index}` },
    }),
  );
  elements.push(fountain);
  const report = summarizePointLandmarks(elements, bbox);
  assert.equal(report.pointLandmarkCount, 81);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /Fontaine des Trois Grâces/);
  assert.match(report.warnings[0], /et 77 autres/);
  assert.ok(report.warnings[0].length < 500);
  assert.deepEqual(summarizePointLandmarks([], bbox), {
    pointLandmarkCount: 0,
    warnings: [],
  });
});

test("imported landmark coordinates are checked while older projects remain valid", () => {
  validateImportedElements(fixture.elements);
  validateImportedElements([
    { type: "node", id: 10, tags: { historic: "monument" } },
  ]);
  validateImportedElements([{ type: "way", id: 11, geometry: [] }]);
  for (const position of [
    { lat: NaN, lon: 3.8795 },
    { lat: Infinity, lon: 3.8795 },
    { lat: 86, lon: 3.8795 },
    { lat: 43.6084697, lon: 181 },
    { lat: 43.6084697, lon: undefined },
    { lat: "43.6084697", lon: 3.8795 },
  ])
    assert.throws(
      () => validateImportedElements([{ ...fountain, ...position }]),
      /Coordonnées géographiques du projet invalides/,
    );
});
