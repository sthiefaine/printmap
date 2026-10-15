import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { POST } from "../src/app/api/map-data/route";
import { RIO_BBOX } from "../src/lib/city-presets";

test("a missing requested DEM is retried instead of caching a flat city; the completed relief is then cached", async (t) => {
  const rgba = Buffer.alloc(256 * 256 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128;
    rgba[i + 1] = 123;
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  const png = new Uint8Array(
    await sharp(rgba, {
      raw: { width: 256, height: 256, channels: 4 },
    })
      .png()
      .toBuffer(),
  );
  let available = false,
    calls = 0,
    osmCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls++;
    const url = new URL(input);
    if (url.pathname.endsWith("/interpreter")) {
      osmCalls++;
      return Response.json({ elements: [] });
    }
    if (url.hostname === "s3.amazonaws.com" && available)
      return new Response(png);
    return new Response("unavailable", { status: 503 });
  });
  const request = () =>
    new Request("http://localhost/api/map-data", {
      method: "POST",
      body: JSON.stringify({ bbox: RIO_BBOX, relief: true }),
    });
  const first = await POST(request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).elevationGrid, null);
  available = true;
  const second = await POST(request());
  assert.equal(second.status, 200);
  const value = await second.json();
  assert.ok(
    value.elevationGrid.points.every((height: number) => height === 123.5),
  );
  assert.equal(osmCalls, 2);
  const completedCalls = calls;
  const third = await POST(request());
  assert.deepEqual(await third.json(), value);
  assert.equal(calls, completedCalls);
});
