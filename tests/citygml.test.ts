import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cityGMLBuildings,
  parseCityGMLBuilding,
} from "../src/lib/data/citygml-parser";
import {
  enrichWithMunicipalRoofs,
  montpellierBatches,
} from "../src/lib/data/montpellier-lod2";
import { fromLambert93, toLambert93 } from "../src/lib/data/lambert93";
import { validateRoofData } from "../src/lib/data/validate-roofs";
import { parseElements } from "../src/lib/osm/parse-elements";
import type { OverpassElement } from "../src/types/osm";

const fixture = () =>
  readFile(
    new URL("./fixtures/montpellier-lod2-b138325.xml", import.meta.url),
    "utf8",
  );
const arcFixture = () =>
  readFile(
    new URL("./fixtures/montpellier-lod2-arc-b137169.xml", import.meta.url),
    "utf8",
  );

test("official Arc de Triomphe retains its complete measured shell and both ground supports", async () => {
  const building = parseCityGMLBuilding(await arcFixture())!;
  assert.equal(building.id, "B137169");
  assert.equal(building.footprints.length, 2);
  assert.equal(building.measuredSolid?.surfaces.length, 90);
  const kinds = building.measuredSolid!.surfaces.reduce<Record<string, number>>(
    (sum, surface) => {
      sum[surface.kind] = (sum[surface.kind] ?? 0) + 1;
      return sum;
    },
    {},
  );
  assert.deepEqual(kinds, {
    roof: 5,
    wall: 61,
    outerFloor: 1,
    outerCeiling: 21,
    ground: 2,
  });
  assert.equal(building.measuredSolid!.year, 2020);
  const merged = enrichWithMunicipalRoofs([], [building]);
  assert.equal(
    merged.elements.length,
    1,
    "one shell must span both feet rather than duplicate/crop the arch",
  );
  validateRoofData(merged.elements);
  const parsed = parseElements(
    merged.elements,
    [43.61, 3.87, 43.62, 3.88],
    5000,
  ).buildings;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].measuredSolid?.surfaces.length, 90);
});

test("unresolved CityGML solid references never masquerade as a complete measured shell", async () => {
  const xml = (await arcFixture()).replace(
    'xlink:href="#ID_',
    'xlink:href="#missing-ID_',
  );
  const building = parseCityGMLBuilding(xml)!;
  assert.equal(building.measuredSolid, undefined);
  assert.equal(building.roofSurfaces.length, 5);
});

test("the measured arch replaces the actual OSM envelope that would otherwise refill its passage", async () => {
  const building = parseCityGMLBuilding(await arcFixture())!;
  const { element } = JSON.parse(
    await readFile(
      new URL("./fixtures/peyrou-osm-arc.json", import.meta.url),
      "utf8",
    ),
  );
  const merged = enrichWithMunicipalRoofs([element], [building]);
  assert.equal(merged.replaced, 1);
  assert.equal(merged.elements.length, 1);
  assert.equal(merged.elements[0].measuredSolid?.surfaces.length, 90);
  assert.ok(!merged.elements.some((item) => item.id === 8656870));
});

test("measured shell import bounds geometry and rejects unclosed vertical rings", async () => {
  const building = parseCityGMLBuilding(await arcFixture())!;
  const element = enrichWithMunicipalRoofs([], [building]).elements[0];
  const invalid = structuredClone(element);
  const wall = invalid.measuredSolid!.surfaces.find(
    (surface) => surface.kind === "wall",
  )!;
  wall.outer.at(-1)!.elevation += 0.5;
  assert.throws(() => validateRoofData([invalid]), /ouvert/);
  assert.throws(
    () =>
      validateRoofData([
        { ...element, measuredSolid: { ...element.measuredSolid!, year: NaN } },
      ]),
    /Coque/,
  );
  assert.throws(
    () =>
      validateRoofData([
        {
          ...element,
          measuredSolid: {
            ...element.measuredSolid!,
            surfaces: Array(5001).fill(wall),
          },
        },
      ]),
    /Coque/,
  );
});

test("official Montpellier CityGML retains actual sloping roof planes and ground altitude", async () => {
  const building = parseCityGMLBuilding(await fixture())!;
  assert.equal(building.id, "B138325");
  assert.equal(building.roofSurfaces.length, 5);
  assert.equal(building.footprints.length, 1);
  assert.equal(building.groundElevation, 26.09);
  assert.ok(Math.abs(building.height - 9.861) < 0.002);
  for (const roof of building.roofSurfaces)
    assert.ok(new Set(roof.outer.map((point) => point.elevation)).size > 1);
  assert.ok(building.bounds[0] > 43.61 && building.bounds[2] < 43.62);
  assert.ok(building.bounds[1] > 3.87 && building.bounds[3] < 3.89);
});

test("Lambert93 conversion retains millimetre precision on measured roof coordinates", () => {
  const origin = toLambert93(3, 46.5);
  assert.ok(Math.abs(origin[0] - 700000) < 1e-6);
  assert.ok(Math.abs(origin[1] - 6600000) < 1e-6);
  const geo = fromLambert93(770788.741426, 6279916.703114);
  const xy = toLambert93(geo.lon, geo.lat);
  assert.ok(Math.abs(xy[0] - 770788.741426) < 0.001);
  assert.ok(Math.abs(xy[1] - 6279916.703114) < 0.001);
});

test("streamed CityGML supports both municipal namespace styles and split delimiters", async () => {
  const xml = await fixture();
  const document = `<CityModel><cityObjectMember>${xml}</cityObjectMember><core:cityObjectMember>${xml.replace('gml:id="B138325"', 'gml:id="B138326"')}</core:cityObjectMember></CityModel>`;
  async function* chunks() {
    const bytes = new TextEncoder().encode(document);
    for (let i = 0; i < bytes.length; i += 73) yield bytes.subarray(i, i + 73);
  }
  const output = [];
  for await (const building of cityGMLBuildings(chunks()))
    output.push(building);
  assert.deepEqual(
    output.map((building) => building.id),
    ["B138325", "B138326"],
  );
});

test("an oversized CityGML member does not consume unbounded memory or hide its successor", async () => {
  const xml = await fixture();
  const document = `<cityObjectMember>${"x".repeat(80000)}</cityObjectMember><core:cityObjectMember>${xml}</core:cityObjectMember>`;
  async function* chunks() {
    const bytes = new TextEncoder().encode(document);
    for (let i = 0; i < bytes.length; i += 4000)
      yield bytes.subarray(i, i + 4000);
  }
  const output = [];
  for await (const building of cityGMLBuildings(chunks(), 60000))
    output.push(building);
  assert.equal(output.length, 1);
  assert.equal(output[0].id, "B138325");
});

test("measured municipal roofs replace an old outline and retain an unmatched newer OSM building", async () => {
  const building = parseCityGMLBuilding(await fixture())!;
  const old: OverpassElement = {
    type: "way",
    id: 1,
    tags: { building: "yes", height: "8" },
    geometry: building.footprints[0].outer,
  };
  const newer: OverpassElement = {
    ...old,
    id: 2,
    geometry: old.geometry!.map((point) => ({
      ...point,
      lon: point.lon + 0.002,
    })),
  };
  const merged = enrichWithMunicipalRoofs([old, newer], [building]);
  assert.equal(merged.replaced, 1);
  assert.equal(merged.added, 1);
  assert.ok(merged.elements.some((element) => element.id === 2));
  assert.ok(!merged.elements.some((element) => element.id === 1));
  validateRoofData(merged.elements);
  const measured = parseElements(
    merged.elements,
    [43.61, 3.87, 43.62, 3.89],
    5000,
  ).buildings.find((item) => item.roofSurfaces)!;
  assert.equal(measured.roofSurfaces?.length, 5);
  assert.equal(measured.groundElevation, 26.09);
  assert.match(measured.roofSource!, /2020/);
});

test("measured roof import rejects invalid altitudes, open rings and excessive detail", async () => {
  const building = parseCityGMLBuilding(await fixture())!;
  const element = enrichWithMunicipalRoofs([], [building]).elements[0];
  validateRoofData([element]);
  const invalid = structuredClone(element);
  invalid.roofSurfaces![0].outer[0].elevation = NaN;
  assert.throws(() => validateRoofData([invalid]), /Altitude/);
  const open = structuredClone(element);
  open.roofSurfaces![0].outer.pop();
  assert.throws(() => validateRoofData([open]), /ouvert/);
  assert.throws(
    () => validateRoofData([{ ...element, groundElevation: Infinity }]),
    /invalides/,
  );
  assert.throws(
    () =>
      validateRoofData([
        {
          ...element,
          roofSurfaces: Array(5001).fill(element.roofSurfaces![0]),
        },
      ]),
    /invalides/,
  );
});

test("municipal spatial index selects the relevant deliveries only", () => {
  assert.deepEqual(montpellierBatches([48.85, 2.34, 48.86, 2.35]), []);
  assert.deepEqual(
    montpellierBatches([43.608, 3.872, 43.616, 3.884]),
    [5, 1, 2],
  );
});
