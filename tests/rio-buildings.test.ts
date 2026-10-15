import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchRioBuildings } from "../src/lib/data/rio-buildings";
import { enrichWithIGN, type IGNFeature } from "../src/lib/data/ign-buildings";
import { RIO_ARCHITECTURE_BBOX, RIO_BBOX } from "../src/lib/city-presets";
import type { OverpassElement } from "../src/types/osm";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/rio-ipp-contours-2019.json", import.meta.url),
    "utf8",
  ),
) as { features: IGNFeature[] };
const volumes = JSON.parse(
  readFileSync(
    new URL("./fixtures/rio-ipp-multiple-volumes-2019.json", import.meta.url),
    "utf8",
  ),
) as { features: IGNFeature[] };
const rioProvenance = {
  source: "Rio IPP 2019",
  heightSource: "Rio IPP published height",
  idStart: -4000000000000,
  eaveHeight: false,
  preserveDistinctVolumes: true,
};
const page = (features = fixture.features) => ({
  type: "FeatureCollection",
  features: features.map((feature) => ({
    geometry: feature.geometry,
    properties: {
      objectid: Number(feature.id.split("/").at(-1)),
      altura: feature.properties.hauteur,
      base: 3,
      topo: 3 + feature.properties.hauteur!,
    },
  })),
});

test("official Rio contours are requested in WGS84 with stable pagination and inconsistent heights are rejected without claiming roof planes", async (t) => {
  const requested: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    requested.push(url);
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(url.searchParams.get("returnZ"), "false");
    assert.equal(url.searchParams.get("orderByFields"), "objectid ASC");
    const output = page();
    output.features[1].properties.topo += 10;
    return Response.json(output);
  });
  const result = await fetchRioBuildings(
    RIO_ARCHITECTURE_BBOX,
    new AbortController().signal,
  );
  assert.equal(requested.length, 1);
  assert.equal(result.features.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("1 contour")));
  const geometry = fixture.features[0].geometry;
  const points = geometry.coordinates as number[][][];
  const element: OverpassElement = {
    type: "way",
    id: 9,
    geometry: points[0].map(([lon, lat]) => ({ lon, lat })),
    tags: { building: "yes", "roof:height": "2" },
  };
  const enriched = enrichWithIGN([element], result.features, {
    source: "Rio IPP",
    heightSource: "Rio IPP published height",
    idStart: -4000000000000,
    eaveHeight: false,
  });
  assert.equal(
    enriched.elements[0].tags!.height,
    String(fixture.features[0].properties.hauteur),
  );
  assert.equal(enriched.elements[0].tags!["printmap:eave_height"], undefined);
  assert.ok(enriched.elements.every((element) => !element.roofSurfaces));
  assert.equal(element.tags!.height, undefined);
});

test("large Rio landscapes and unrelated cities do not trigger an unbounded municipal download", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("must not fetch");
  });
  const large = await fetchRioBuildings(RIO_BBOX, new AbortController().signal);
  assert.equal(large.features.length, 0);
  assert.ok(large.warnings.some((warning) => warning.includes("4 km²")));
  const elsewhere = await fetchRioBuildings(
    [45.43, 4.38, 45.44, 4.39],
    new AbortController().signal,
  );
  assert.deepEqual(elsewhere, { features: [], warnings: [] });
  assert.equal(calls, 0);
});

test("distinct real IPP building/projection volumes retain their own published heights while the default IGN policy is unchanged", () => {
  const before = structuredClone(volumes.features);
  const ordinary = enrichWithIGN([], volumes.features);
  assert.equal(
    ordinary.added,
    1,
    "the default IGN deduplication policy is unchanged",
  );
  const result = enrichWithIGN([], volumes.features, rioProvenance);
  assert.equal(result.added, 3);
  assert.deepEqual(
    result.elements.map((element) => [
      element.tags!["printmap:source_id"],
      element.tags!.height,
    ]),
    [
      ["RIO/IPP/2019/1811798", "3.55"],
      ["RIO/IPP/2019/1811801", "14.08"],
      ["RIO/IPP/2019/1811802", "14.04"],
    ],
  );
  assert.ok(
    result.elements.every(
      (element) => !element.roofSurfaces && !element.measuredSolid,
    ),
  );
  assert.deepEqual(volumes.features, before);
  const repeated = enrichWithIGN(
    result.elements,
    volumes.features,
    rioProvenance,
  );
  assert.equal(
    repeated.added,
    0,
    "the same source IDs and contours must not be duplicated on a repeated enrichment",
  );
  assert.equal(repeated.elements.length, 3);
});

test("weak OSM overlap cannot absorb municipal volumes and explicit OSM measurements remain intact", () => {
  const points = volumes.features.flatMap((feature) =>
    (feature.geometry.coordinates as number[][][]).flat(),
  );
  const west = Math.min(...points.map(([lon]) => lon)) - 0.00015;
  const east = Math.max(...points.map(([lon]) => lon)) + 0.00015;
  const south = Math.min(...points.map(([, lat]) => lat)) - 0.00015;
  const north = Math.max(...points.map(([, lat]) => lat)) + 0.00015;
  const large: OverpassElement = {
    type: "way",
    id: 990,
    tags: {
      building: "yes",
      height: "50",
      name: "Existing measured OSM envelope",
    },
    geometry: [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ].map(([lon, lat]) => ({ lon, lat })),
  };
  const before = structuredClone(large);
  const result = enrichWithIGN([large], volumes.features, rioProvenance);
  assert.equal(result.added, 3);
  assert.equal(result.enriched, 0);
  assert.deepEqual(result.elements[0], large);
  assert.deepEqual(large, before);
  assert.equal(result.elements.length, 4);
  // A coarse OSM envelope is deliberately retained: deleting it without proof
  // of full source coverage would discard explicitly measured OSM geometry.
  assert.equal(result.elements[0].tags!.height, "50");
});

test("a close OSM footprint can gain a published total height without adding roof height or discarding neighbouring source levels", () => {
  const original: OverpassElement = {
    type: "way",
    id: 991,
    tags: { building: "yes", "roof:height": "2" },
    geometry: (volumes.features[0].geometry.coordinates as number[][][])[0].map(
      ([lon, lat]) => ({ lon, lat }),
    ),
  };
  const result = enrichWithIGN([original], volumes.features, rioProvenance);
  assert.equal(result.enriched, 1);
  assert.equal(result.elements[0].tags!.height, "3.55");
  assert.equal(result.elements[0].tags!["printmap:eave_height"], undefined);
  assert.equal(result.added, 2);
  assert.deepEqual(
    result.elements.slice(1).map((element) => element.tags!.height),
    ["14.08", "14.04"],
  );
  assert.equal(original.tags!.height, undefined);
});

test("Rio pagination follows transfer-limit flags through short pages and keeps valid partial results", async (t) => {
  const offsets: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const offset = new URL(input).searchParams.get("resultOffset")!;
    offsets.push(offset);
    if (offset === "0")
      return Response.json({
        ...page([fixture.features[0]]),
        exceededTransferLimit: true,
      });
    if (offset === "1")
      return Response.json({
        ...page([fixture.features[0], fixture.features[2]]),
        exceededTransferLimit: true,
      });
    return new Response("temporary upstream error", { status: 503 });
  });
  const result = await fetchRioBuildings(
    RIO_ARCHITECTURE_BBOX,
    new AbortController().signal,
  );
  assert.deepEqual(offsets, ["0", "1", "3"]);
  assert.equal(
    result.features.length,
    2,
    "repeated object IDs are deduplicated across pages",
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("partiellement")),
  );
});

test("Rio pagination is bounded to six pages and cancellation propagates", async (t) => {
  let calls = 0;
  const output = page([fixture.features[0]]).features[0];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls++;
    const offset = Number(new URL(input).searchParams.get("resultOffset"));
    return Response.json({
      features: Array.from({ length: 1000 }, (_, index) => ({
        ...output,
        properties: { ...output.properties, objectid: offset + index + 1 },
      })),
      exceededTransferLimit: true,
    });
  });
  const result = await fetchRioBuildings(
    RIO_ARCHITECTURE_BBOX,
    new AbortController().signal,
  );
  assert.equal(calls, 6);
  assert.equal(result.features.length, 6000);
  assert.ok(result.warnings.some((warning) => warning.includes("6 000")));
  const controller = new AbortController();
  controller.abort(new Error("cancel municipal contours"));
  await assert.rejects(
    fetchRioBuildings(RIO_ARCHITECTURE_BBOX, controller.signal),
    /cancel municipal contours/,
  );
  assert.equal(calls, 6);
});
