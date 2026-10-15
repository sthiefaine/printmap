import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fetchTerrainTiles } from "../src/lib/data/terrain-tiles";
import { validateElevationGrid } from "../src/lib/elevation/validate-grid";
import type { BBox } from "../src/types/osm";

const world = 256 * 8192;
const boundaryX = 3113 * 256,
  boundaryY = 4633 * 256;
const longitude = (boundaryX / world) * 360 - 180;
const latitude =
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * boundaryY) / world))) * 180) /
  Math.PI;
const bbox: BBox = [
  latitude - 0.0004,
  longitude - 0.0004,
  latitude + 0.0004,
  longitude + 0.0004,
];
const pixelX = (lon: number) => ((lon + 180) / 360) * world - 0.5;
const pixelY = (lat: number) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * world -
  0.5;
const elevation = (x: number, y: number) =>
  200 + (x - boundaryX) / 4 + (y - boundaryY) / 2;

async function tile(x: number, y: number, transparent = false) {
  const data = Buffer.alloc(256 * 256 * 4);
  for (let row = 0; row < 256; row++)
    for (let col = 0; col < 256; col++) {
      const index = (row * 256 + col) * 4;
      const encoded = Math.round(
        (elevation(x * 256 + col, y * 256 + row) + 32768) * 256,
      );
      data[index] = (encoded >> 16) & 255;
      data[index + 1] = (encoded >> 8) & 255;
      data[index + 2] = encoded & 255;
      data[index + 3] = transparent ? 0 : 255;
    }
  return sharp(data, { raw: { width: 256, height: 256, channels: 4 } })
    .png()
    .toBuffer();
}

test("Terrarium keeps measured RGB heights, fractional metres and south-to-north rows continuous across four tile seams", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    const match = url.match(/\/13\/(\d+)\/(\d+)\.png$/)!;
    assert.ok(match);
    return new Response(
      new Uint8Array(await tile(Number(match[1]), Number(match[2]))),
    );
  });
  const grid = await fetchTerrainTiles(bbox, new AbortController().signal);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests).size, 4);
  assert.deepEqual(validateElevationGrid(grid), grid);
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.cols; col++) {
      const x = pixelX(bbox[1] + (col / (grid.cols - 1)) * (bbox[3] - bbox[1]));
      const y = pixelY(bbox[0] + (row / (grid.rows - 1)) * (bbox[2] - bbox[0]));
      assert.ok(
        Math.abs(grid.points[row * grid.cols + col] - elevation(x, y)) < 1e-8,
      );
    }
  assert.ok(grid.points[0] > grid.points.at(-grid.cols)!);
  assert.match(grid.source!, /Mapzen.*USGS.*NOAA/);
  assert.ok(grid.maxElev > grid.minElev);
});

test("missing or invalid terrain tiles never insert a zero-height patch and cancellation sends no requests", async (t) => {
  let mode = "http",
    calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    if (mode === "http") return new Response("unavailable", { status: 503 });
    if (mode === "json") return Response.json({ error: "not a DEM" });
    const match = url.match(/\/13\/(\d+)\/(\d+)\.png$/)!;
    return new Response(
      new Uint8Array(await tile(Number(match[1]), Number(match[2]), true)),
    );
  });
  for (mode of ["http", "json", "transparent"])
    await assert.rejects(fetchTerrainTiles(bbox, new AbortController().signal));
  const count = calls;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(fetchTerrainTiles(bbox, controller.signal), /cancelled/);
  assert.equal(calls, count);
});
