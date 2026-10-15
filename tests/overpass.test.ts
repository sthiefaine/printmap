import test from "node:test";
import assert from "node:assert/strict";
import { fetchOverpass } from "../src/lib/data/overpass";
import type { BBox } from "../src/types/osm";

const bbox: BBox = [45.4288, 4.3702, 45.4628, 4.406];

test("two unavailable Overpass servers fall back to the complete unchanged selection on the independent GET mirror", async (t) => {
  const calls: { url: URL; options: RequestInit }[] = [];
  const element = { type: "way", id: 42, tags: { building: "yes" } };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls.push({ url: new URL(url), options });
      return calls.length < 3
        ? new Response("unavailable", {
            status: calls.length === 1 ? 502 : 500,
          })
        : Response.json({
            elements: [element],
            osm3s: { timestamp_osm_base: "2026-10-15T09:00:00Z" },
          });
    },
  );
  const result = await fetchOverpass(bbox, new AbortController().signal);
  assert.deepEqual(result.elements, [element]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.hostname, "maps.mail.ru");
  assert.equal(calls[2].options.method, "GET");
  assert.equal(calls[2].options.body, undefined);
  for (const call of calls) {
    const query =
      call.options.method === "GET"
        ? call.url.searchParams.get("data")!
        : (call.options.body as URLSearchParams).get("data")!;
    assert.ok(query.includes(bbox.join(",")));
    for (const selector of [
      'wr["building"]',
      'wr["building:part"]',
      'way["highway"]',
      'wr["bridge"]',
    ])
      assert.ok(query.includes(selector));
    assert.ok(call.options.signal);
  }
  assert.equal(result.osm3s?.timestamp_osm_base, "2026-10-15T09:00:00Z");
});

test("invalid JSON and partial HTTP 200 output are never used as a city", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response("<html>gateway failure</html>")
      : calls === 2
        ? Response.json({
            elements: [{ type: "way", id: 1 }],
            remark: "runtime error: timeout",
          })
        : Response.json({ elements: [{ type: "way", id: 2 }] });
  });
  const data = await fetchOverpass(bbox, new AbortController().signal);
  assert.deepEqual(
    data.elements.map((element) => element.id),
    [2],
  );
  assert.equal(calls, 3);
});

test("cancellation stops failover and dense geometry still fails without dropping features", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    controller.abort(new Error("cancelled by user"));
    throw new Error("network failure");
  });
  await assert.rejects(
    fetchOverpass(bbox, controller.signal),
    /cancelled by user/,
  );
  assert.equal(calls, 1);
  mock.mock.mockImplementation(async () => {
    calls++;
    return Response.json({
      elements: Array.from({ length: 70001 }, (_, id) => ({ type: "way", id })),
    });
  });
  await assert.rejects(
    fetchOverpass(bbox, new AbortController().signal),
    /Zone trop dense/,
  );
  assert.equal(calls, 2);
});

test("an operator's configured Overpass endpoint stays exclusive and uses POST", async (t) => {
  const original = process.env.OVERPASS_URL;
  process.env.OVERPASS_URL = "https://example.test/api/interpreter";
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls.push(url);
      assert.equal(options.method, "POST");
      return new Response("unavailable", { status: 503 });
    },
  );
  try {
    await assert.rejects(
      fetchOverpass(bbox, new AbortController().signal),
      /Votre sélection est conservée/,
    );
    assert.deepEqual(calls, [process.env.OVERPASS_URL]);
  } finally {
    if (original === undefined) delete process.env.OVERPASS_URL;
    else process.env.OVERPASS_URL = original;
  }
});
