import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/elevation/route";

test("terrain-only endpoint rejects invalid selections before contacting public services", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  try {
    for (const body of [
      { bbox: [43, 3, 42, 4] },
      { bbox: [-80, -170, 80, 170] },
      {},
    ]) {
      const response = await POST(
        new Request("http://localhost/api/elevation", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("terrain-only endpoint returns a dense validated grid without collecting city geometry", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    assert.ok(String(url).includes("altimetrie"));
    const query = JSON.parse(String(init?.body));
    const count = query.lat.split("|").length;
    assert.ok(count <= 4900);
    return new Response(
      JSON.stringify({
        elevations: Array.from({ length: count }, (_, i) => 30 + (i % 5)),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const response = await POST(
      new Request("http://localhost/api/elevation", {
        method: "POST",
        body: JSON.stringify({ bbox: [43.61, 3.87, 43.612, 3.872] }),
      }),
    );
    assert.equal(response.status, 200);
    const { elevationGrid } = await response.json();
    assert.equal(
      elevationGrid.points.length,
      elevationGrid.rows * elevationGrid.cols,
    );
    assert.equal(elevationGrid.minElev, 30);
    assert.equal(elevationGrid.maxElev, 34);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
