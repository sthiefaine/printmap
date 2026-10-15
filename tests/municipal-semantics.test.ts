import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enrichWithMunicipalRoofs } from "../src/lib/data/montpellier-lod2";
import { buildingLandmark } from "../src/lib/data/building-landmarks";
import { parseCityJSONBuildings } from "../src/lib/data/cityjson-parser";
import type { Lod2Building } from "../src/lib/data/citygml-parser";
import type { GeographicPolygon } from "../src/lib/osm/relation-polygons";
import type { OverpassElement } from "../src/types/osm";

function square(x = 0, y = 0, size = 10): GeographicPolygon {
  return {
    outer: [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ].map(([lon, lat]) => ({ lat: 43 + lat / 100000, lon: 3 + lon / 100000 })),
    holes: [],
  };
}
function building(id = "B1", footprint = square()): Lod2Building {
  return {
    id,
    footprints: [footprint],
    roofSurfaces: [
      {
        outer: footprint.outer.map((p) => ({ ...p, elevation: 35 })),
        holes: [],
      },
    ],
    groundElevation: 20,
    height: 15,
    bounds: [
      Math.min(...footprint.outer.map((p) => p.lat)),
      Math.min(...footprint.outer.map((p) => p.lon)),
      Math.max(...footprint.outer.map((p) => p.lat)),
      Math.max(...footprint.outer.map((p) => p.lon)),
    ],
  };
}
function way(
  id = 1,
  footprint = square(),
  tags: Record<string, string> = {},
): OverpassElement {
  return {
    type: "way",
    id,
    tags: { building: "yes", ...tags },
    geometry: footprint.outer,
  };
}
function municipal(elements: OverpassElement[], buildings: Lod2Building[]) {
  return enrichWithMunicipalRoofs(elements, buildings).elements.filter(
    (e) => e.tags?.["printmap:source_id"],
  );
}

test("a uniquely matched monument retains OSM identity while measured geometry and provenance remain authoritative", () => {
  const surveyed = building(),
    original = way(1, square(), {
      name: "Église test",
      "name:en": "Test church",
      building: "church",
      amenity: "place_of_worship",
      historic: "church",
      tourism: "attraction",
      religion: "christian",
      denomination: "catholic",
      wikidata: "Q123",
      wikipedia: "fr:Test",
      "addr:street": "Rue du Test",
      height: "99",
      "building:levels": "40",
      "roof:shape": "pyramidal",
      "roof:height": "20",
      source: "old OSM geometry",
      "printmap:height_source": "old height",
    });
  const before = structuredClone({ surveyed, original });
  const [result] = municipal([original], [surveyed]);
  assert.equal(result.tags?.name, "Église test");
  assert.equal(result.tags?.["name:en"], "Test church");
  assert.equal(result.tags?.building, "church");
  assert.equal(result.tags?.historic, "church");
  assert.equal(result.tags?.amenity, "place_of_worship");
  assert.equal(result.tags?.tourism, "attraction");
  assert.equal(result.tags?.["addr:street"], "Rue du Test");
  assert.equal(result.tags?.["printmap:osm_id"], "way/1");
  assert.equal(result.tags?.height, "15");
  assert.match(result.tags!["printmap:height_source"], /LoD2 mesurée/);
  assert.equal(result.tags?.["building:levels"], undefined);
  assert.equal(result.tags?.["roof:shape"], undefined);
  assert.equal(result.tags?.["roof:height"], undefined);
  assert.equal(result.tags?.source, undefined);
  assert.equal(result.roofSurfaces, surveyed.roofSurfaces);
  assert.deepEqual({ surveyed, original }, before);
});

test("a named multipolygon owns its duplicated member identity, preserving courtyard holes", () => {
  const outer = square(),
    hole = square(3, 3, 4).outer,
    shape = { ...outer, holes: [hole] };
  const member = way(2, outer, { name: "Duplicate member" });
  const relation: OverpassElement = {
    type: "relation",
    id: 5,
    tags: { type: "multipolygon", building: "cathedral", name: "Cathédrale" },
    members: [
      { type: "way", ref: 2, role: "outer", geometry: outer.outer },
      { type: "way", role: "inner", geometry: hole },
    ],
  };
  const [result] = municipal([member, relation], [building("B1", shape)]);
  assert.equal(result.tags?.name, "Cathédrale");
  assert.equal(result.tags?.building, "cathedral");
  assert.equal(result.tags?.["printmap:osm_id"], "relation/5");
  assert.deepEqual(result.members?.[1].geometry, hole);
});

test("an unnamed multipolygon can retain the identity of its named outer way", () => {
  const outer = square(),
    member = way(2, outer, { name: "Hôtel de Ville" });
  const relation: OverpassElement = {
    type: "relation",
    id: 5,
    tags: { type: "multipolygon", building: "yes" },
    members: [{ type: "way", ref: 2, role: "outer", geometry: outer.outer }],
  };
  const [result] = municipal([member, relation], [building()]);
  assert.equal(result.tags?.name, "Hôtel de Ville");
  assert.equal(result.tags?.["printmap:osm_id"], "way/2");
});

test("an unnamed typed relation preserves its named outer identity and civic usage", () => {
  const outer = square();
  const member = way(2, outer, { name: "Chapelle reconnue" });
  const relation: OverpassElement = {
    type: "relation",
    id: 5,
    tags: {
      type: "multipolygon",
      building: "church",
      amenity: "place_of_worship",
    },
    members: [{ type: "way", ref: 2, role: "outer", geometry: outer.outer }],
  };
  const [result] = municipal([member, relation], [building()]);
  assert.equal(result.tags?.name, "Chapelle reconnue");
  assert.equal(result.tags?.building, "church");
  assert.equal(result.tags?.amenity, "place_of_worship");
  assert.equal(result.tags?.["printmap:osm_id"], "way/2");
  assert.equal(result.tags?.height, "15");
  assert.match(result.tags!["printmap:height_source"], /LoD2 mesurée/);
});

test("an unrelated unnamed outline does not resolve an ambiguous named match", () => {
  const named = way(1, square(), { name: "École" });
  const unnamed = way(2, square(), { building: "church" });
  const [result] = municipal([named, unnamed], [building()]);
  assert.equal(result.tags?.name, undefined);
  assert.equal(result.tags?.["printmap:osm_id"], undefined);
});

for (const usage of [{ shop: "mall" }, { leisure: "stadium" }] as Record<
  string,
  string
>[])
  test(`municipal geometry retains landmark usage ${JSON.stringify(usage)}`, () => {
    const original = way(1, square(), {
      name: "Lieu remarquable",
      ...usage,
      height: "99",
    });
    const [result] = municipal([original], [building()]);
    for (const [key, value] of Object.entries(usage))
      assert.equal(result.tags?.[key], value);
    assert.equal(result.tags?.name, "Lieu remarquable");
    assert.equal(result.tags?.["printmap:osm_id"], "way/1");
    assert.equal(result.tags?.height, "15");
    assert.match(result.tags!["printmap:height_source"], /LoD2 mesurée/);
    assert.deepEqual(
      buildingLandmark({
        sourceId: result.tags!["printmap:source_id"],
        tags: result.tags!,
      }),
      { id: "way/1", name: "Lieu remarquable" },
    );
  });

test("two distinct OSM identities inside a merged survey are not arbitrarily assigned", () => {
  const surveyed = building("B1", square(0, 0, 20));
  const left = way(1, square(0, 0, 13), { name: "École" });
  const right = way(2, square(7, 7, 13), { name: "Chapelle" });
  const [result] = municipal([left, right], [surveyed]);
  assert.equal(result.tags?.name, undefined);
  assert.equal(result.tags?.["printmap:osm_id"], undefined);
});

test("one OSM identity matching two distinct surveys is not duplicated across them", () => {
  const shared = way(1, square(), { name: "Ambiguous monument" });
  const results = municipal([shared], [building("B1"), building("B2")]);
  assert.equal(results.length, 2);
  assert.ok(
    results.every(
      (e) =>
        e.tags?.name === undefined && e.tags?.["printmap:osm_id"] === undefined,
    ),
  );
});

test("a named small outbuilding cannot name a much larger envelope, nor a surveyed courtyard", () => {
  const large = building("B1", square(0, 0, 30));
  const tiny = way(1, square(10, 10, 5), { name: "Annexe" });
  assert.equal(municipal([tiny], [large])[0].tags?.name, undefined);
  const courtyard = square(5, 5, 20).outer;
  large.footprints[0].holes = [courtyard];
  const result = enrichWithMunicipalRoofs([tiny], [large]);
  assert.ok(
    result.elements.includes(tiny),
    "an OSM building in the real hole remains unmatched and retained",
  );
  assert.equal(
    result.elements.find((e) => e.tags?.["printmap:source_id"])?.tags?.name,
    undefined,
  );
});

test("building outline identity wins over an overlapping part and supports multiple surveyed ground supports", () => {
  const surveyed = building();
  surveyed.footprints = [square(0, 0, 4), square(6, 6, 4)];
  const outer = way(1, square(), { building: "church", name: "Église" });
  const part = way(2, square(0, 0, 4), {
    "building:part": "yes",
    name: "Clocher",
  });
  // A shell's projection covers the span between the two real ground supports.
  surveyed.measuredSolid = {
    source: "Measured",
    year: 2020,
    surfaces: [
      {
        kind: "roof",
        outer: square().outer.map((p) => ({ ...p, elevation: 35 })),
        holes: [],
      },
    ],
  };
  const results = municipal([outer, part], [surveyed]);
  assert.equal(results.length, 2);
  assert.ok(
    results.every(
      (e) =>
        e.tags?.name === "Église" && e.tags?.["printmap:osm_id"] === "way/1",
    ),
  );
  assert.ok(results.every((e) => e.measuredSolid === surveyed.measuredSolid));
});

test("real Arbre Blanc retains its identity despite the surveyed terrace envelope exceeding the OSM core", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
      "utf8",
    ),
  );
  const boundaries = JSON.parse(
    readFileSync(
      new URL("../src/lib/data/arbre-blanc-lidar.json", import.meta.url),
      "utf8",
    ),
  );
  const source = fixture.osmData.elements[0] as OverpassElement;
  const surveyed = building("B102558", boundaries.groundFootprint);
  surveyed.roofSurfaces = source.roofSurfaces!;
  surveyed.groundElevation = source.groundElevation!;
  surveyed.height = Number(source.tags!.height);
  const osm = way(441634682, boundaries.coreFootprint, {
    name: "L’Arbre Blanc",
    building: "apartments",
    "building:levels": "17",
    height: "56",
  });
  const [result] = municipal([osm], [surveyed]);
  assert.equal(result.tags?.name, "L’Arbre Blanc");
  assert.equal(result.tags?.["printmap:osm_id"], "way/441634682");
  assert.equal(result.tags?.height, source.tags!.height);
  assert.equal(result.roofSurfaces!.length, 69);
});

test("the shared CRAIG enrichment preserves a named surveyed church without changing CityJSON heights", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/saint-etienne-craig-cityjson.json", import.meta.url),
      "utf8",
    ),
  );
  const parsed = parseCityJSONBuildings(fixture.document, {
    source: "CRAIG survey",
    year: 2021,
  });
  assert.ok(parsed.buildings.length > 0);
  const surveyed = parsed.buildings[0],
    original = way(123, surveyed.footprints[0], {
      name: "Identité OSM de contrôle",
      building: "church",
      height: "999",
    });
  const result = enrichWithMunicipalRoofs([original], [surveyed], {
    source: "CRAIG survey",
    prefix: "CRAIG",
    heightSource: "CRAIG geometry",
    year: 2021,
  });
  const measured = result.elements.find((e) => e.tags?.["printmap:source_id"]);
  assert.equal(measured?.tags?.name, "Identité OSM de contrôle");
  assert.equal(measured?.tags?.["printmap:osm_id"], "way/123");
  assert.equal(measured?.tags?.height, String(surveyed.height));
  assert.equal(measured?.tags?.["printmap:source_id"], `CRAIG/${surveyed.id}`);
  assert.equal(measured?.roofSurfaces, surveyed.roofSurfaces);
});
