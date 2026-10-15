import test from "node:test";
import assert from "node:assert/strict";
import { fetchElevation } from "../src/lib/data/elevation";
import { validateElevationGrid } from "../src/lib/elevation/validate-grid";
import { bboxDimensions } from "../src/lib/data/bbox";
import type { BBox } from "../src/types/osm";

const peyrou: BBox = [43.6099, 3.8677, 43.6131, 3.8745];
type AltimetryBody = { resource: string; lat: string; lon: string };

function bodyOf(options: RequestInit) {
  return JSON.parse(options.body as string) as AltimetryBody;
}

function complete(body: AltimetryBody, elevation: number) {
  return Response.json({
    elevations: body.lat.split("|").map(() => elevation),
  });
}

test("complete LiDAR MNT uses one bounded request and reports actual grid spacing, not its native 50 cm", async (t) => {
  const requests: AltimetryBody[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = bodyOf(options);
      requests.push(body);
      assert.ok(options.signal instanceof AbortSignal);
      return complete(body, 44.34);
    },
  );
  const result = await fetchElevation(peyrou, new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].resource, "ign_lidar_hd_mnt_mono_wld");
  assert.equal(requests[0].lat.split("|").length, result.rows * result.cols);
  assert.equal(requests[0].lon.split("|").length, result.rows * result.cols);
  assert.ok(result.points.length <= 4900);
  assert.equal(result.minElev, 44.34);
  assert.equal(result.maxElev, 44.34);
  assert.match(result.source!, /LiDAR HD MNT.*IGN69.*Licence Ouverte/);
  assert.equal(result.warnings, undefined);
  const dimensions = bboxDimensions(peyrou);
  assert.equal(
    result.resolutionM,
    Math.max(
      0.5,
      dimensions.widthM / (result.cols - 1),
      dimensions.heightM / (result.rows - 1),
    ),
  );
  assert.ok(result.resolutionM! > 5);
  assert.deepEqual(validateElevationGrid(result).points, result.points);
});

for (const failure of ["missing", "outlier", "truncated", "http"] as const) {
  test(`LiDAR ${failure} replaces the entire grid with RGE ALTI and declares the fallback`, async (t) => {
    const resources: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, options: RequestInit) => {
        const body = bodyOf(options);
        resources.push(body.resource);
        if (body.resource === "ign_rge_alti_wld") return complete(body, 44.29);
        if (failure === "http")
          return new Response("Unavailable", { status: 503 });
        const elevations = body.lat.split("|").map(() => 58.13);
        if (failure === "missing") elevations[0] = -99999;
        if (failure === "outlier") elevations[0] = -999;
        if (failure === "truncated") elevations.pop();
        return Response.json({ elevations });
      },
    );
    const result = await fetchElevation(peyrou, new AbortController().signal);
    assert.deepEqual(resources, [
      "ign_lidar_hd_mnt_mono_wld",
      "ign_rge_alti_wld",
    ]);
    assert.ok(result.points.every((z) => z === 44.29));
    assert.equal(result.minElev, 44.29);
    assert.equal(result.maxElev, 44.29);
    assert.equal(result.source, "IGN · RGE ALTI");
    assert.match(result.warnings![0], /LiDAR HD.*replie sur RGE ALTI/);
    assert.ok(!result.warnings!.some((warning) => warning.includes("90 m")));
  });
}

test("LiDAR cancellation aborts acquisition without starting a fallback", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      requests++;
      const signal = options.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        controller.abort(
          new DOMException("Collection cancelled", "AbortError"),
        );
      });
    },
  );
  await assert.rejects(fetchElevation(peyrou, controller.signal), {
    name: "AbortError",
  });
  assert.equal(requests, 1);
});

test("an already cancelled collection never contacts an elevation provider", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Unexpected request");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchElevation(peyrou, controller.signal), {
    name: "AbortError",
  });
  assert.equal(requests, 0);
});

test("the LiDAR deadline is bounded and its timeout can fall back without cancelling RGE ALTI", async (t) => {
  const deadlines: number[] = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    if (milliseconds !== 12000) return originalTimeout(milliseconds);
    const controller = new AbortController();
    controller.abort(new DOMException("Provider timeout", "TimeoutError"));
    return controller.signal;
  });
  const resources: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = bodyOf(options);
      resources.push(body.resource);
      options.signal!.throwIfAborted();
      return complete(body, 44.29);
    },
  );
  const result = await fetchElevation(peyrou, new AbortController().signal);
  assert.deepEqual(deadlines, [12000, 18000]);
  assert.deepEqual(resources, [
    "ign_lidar_hd_mnt_mono_wld",
    "ign_rge_alti_wld",
  ]);
  assert.equal(result.source, "IGN · RGE ALTI");
});

test("Corsican LiDAR provenance uses its legal IGN78C vertical datum", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) =>
      complete(bodyOf(options), 50),
  );
  const result = await fetchElevation(
    [41.925, 8.735, 41.9255, 8.7355],
    new AbortController().signal,
  );
  assert.match(result.source!, /IGN78C/);
  assert.ok(!result.source!.includes("IGN69"));
});

test("outside metropolitan France falls back to Copernicus when the complete terrain mosaic is unavailable", async (t) => {
  const global: BBox = [40.7, -74.01, 40.7005, -74.0095];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, options: RequestInit) => {
      assert.equal(options.body, undefined);
      const url = new URL(input);
      if (url.hostname === "s3.amazonaws.com")
        return new Response("unavailable", { status: 503 });
      return Response.json({
        elevation: url.searchParams
          .get("latitude")!
          .split(",")
          .map(() => 10),
      });
    },
  );
  const result = await fetchElevation(global, new AbortController().signal);
  assert.match(result.source!, /Copernicus DEM GLO-90/);
  assert.match(result.warnings![0], /tuiles.*indisponibles.*Copernicus/);
});
