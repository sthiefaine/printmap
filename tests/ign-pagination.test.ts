import test from "node:test";
import assert from "node:assert/strict";
import { fetchIGNBuildings } from "../src/lib/data/ign-buildings";
import type { BBox } from "../src/types/osm";

const bbox: BBox = [45.4288, 4.3702, 45.454, 4.406];
const pageSize = 2500;

function feature(index: number) {
  return {
    id: `batiment.${index}`,
    properties: { cleabs: `BATIMENT${index}`, hauteur: 15.8 },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [4.395, 45.449],
          [4.396, 45.449],
          [4.396, 45.45],
          [4.395, 45.449],
        ],
      ],
    },
  };
}

function page(start: number, size: number, numberMatched: number | string) {
  return Response.json({
    features: Array.from({ length: size }, (_, i) => feature(start + i)),
    numberMatched,
    numberReturned: size,
  });
}

function parameters(input: string) {
  const url = new URL(input);
  assert.equal(url.origin, "https://data.geopf.fr");
  assert.equal(url.searchParams.get("REQUEST"), "GetFeature");
  assert.equal(url.searchParams.get("TYPENAMES"), "BDTOPO_V3:batiment");
  assert.equal(url.searchParams.get("SORTBY"), "cleabs");
  assert.equal(url.searchParams.get("RESULTTYPE"), null);
  assert.equal(Number(url.searchParams.get("COUNT")), pageSize);
  return Number(url.searchParams.get("STARTINDEX"));
}

test("a dense zone completes its fifth IGN page instead of losing buildings after 10,000", async (t) => {
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const start = parameters(input);
    starts.push(start);
    return page(start, Math.min(pageSize, 12055 - start), 12055);
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.deepEqual(starts, [0, 2500, 5000, 7500, 10000]);
  assert.equal(result.features.length, 12055);
  assert.equal(result.features.at(-1)!.properties.cleabs, "BATIMENT12054");
  assert.deepEqual(result.warnings, []);
});

test("a small complete zone makes one request without a preliminary hits request", async (t) => {
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const start = parameters(input);
    starts.push(start);
    return page(start, 16, 16);
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.deepEqual(starts, [0]);
  assert.equal(result.features.length, 16);
  assert.deepEqual(result.warnings, []);
});

for (const numberMatched of [30000, "unknown"] as const) {
  test(`IGN acquisition with count ${numberMatched} is bounded to eight pages and declares truncation`, async (t) => {
    const starts: number[] = [];
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const start = parameters(input);
      starts.push(start);
      return page(start, pageSize, numberMatched);
    });
    const result = await fetchIGNBuildings(bbox, new AbortController().signal);
    assert.equal(starts.length, 8);
    assert.equal(starts.at(-1), 17500);
    assert.equal(result.features.length, 20000);
    assert.match(result.warnings[0], /limité aux 20 000/);
  });
}

test("exactly 20,000 matched buildings complete without a false truncation warning", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests++;
    return page(parameters(input), pageSize, 20000);
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.equal(requests, 8);
  assert.equal(result.features.length, 20000);
  assert.deepEqual(result.warnings, []);
});

test("changing matched counts use the current page and never add speculative requests", async (t) => {
  const matched = ["unknown", 15000, 12500, 13000, 12055];
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const start = parameters(input);
    starts.push(start);
    return page(
      start,
      Math.min(pageSize, 12055 - start),
      matched[starts.length - 1],
    );
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.deepEqual(starts, [0, 2500, 5000, 7500, 10000]);
  assert.equal(result.features.length, 12055);
  assert.deepEqual(result.warnings, []);
});

test("page offsets count raw records while duplicate source IDs and destroyed buildings are excluded", async (t) => {
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const start = parameters(input);
    starts.push(start);
    if (start === 0) {
      const features = Array.from({ length: pageSize }, (_, i) => feature(i));
      Object.assign(features[0].properties, { etat_de_l_objet: "Détruit" });
      Object.assign(features[1], { geometry: null });
      return Response.json({ features, numberMatched: 2503 });
    }
    const duplicate = feature(3000);
    duplicate.properties.cleabs = "BATIMENT2499";
    const destroyed = feature(2501);
    Object.assign(destroyed.properties, { etat_de_l_objet: "Détruit" });
    return Response.json({
      features: [duplicate, feature(2500), destroyed],
      numberMatched: 2503,
    });
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.deepEqual(starts, [0, 2500]);
  assert.equal(result.features.length, 2499);
  assert.equal(
    new Set(result.features.map((f) => f.properties.cleabs)).size,
    2499,
  );
  assert.deepEqual(result.warnings, []);
});

test("a later HTTP failure preserves acquired heights and declares partial coverage", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests++;
    const start = parameters(input);
    return start === 0
      ? page(0, pageSize, 12055)
      : new Response("Unavailable", { status: 503 });
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.equal(requests, 2);
  assert.equal(result.features.length, pageSize);
  assert.match(result.warnings[0], /IGN partiel/);
});

test("an already cancelled acquisition does not contact IGN", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Unexpected request");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchIGNBuildings(bbox, controller.signal), {
    name: "AbortError",
  });
  assert.equal(requests, 0);
});

test("cancellation between pages propagates instead of returning a partial success", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests++;
    const start = parameters(input);
    controller.abort();
    return page(start, pageSize, 12055);
  });
  await assert.rejects(fetchIGNBuildings(bbox, controller.signal), {
    name: "AbortError",
  });
  assert.equal(requests, 1);
});

test("the shared 22-second deadline preserves only acquired pages and stops further requests", async (t) => {
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    return milliseconds === 22000
      ? deadline.signal
      : originalTimeout(milliseconds);
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests++;
    const start = parameters(input);
    deadline.abort(new DOMException("IGN deadline", "TimeoutError"));
    return page(start, pageSize, 12055);
  });
  const result = await fetchIGNBuildings(bbox, new AbortController().signal);
  assert.equal(requests, 1);
  assert.deepEqual(timeouts, [22000, 14000]);
  assert.equal(result.features.length, pageSize);
  assert.match(result.warnings[0], /IGN partiel/);
});
