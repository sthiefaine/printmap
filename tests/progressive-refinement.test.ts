import assert from "node:assert/strict";
import test from "node:test";
import type { BBox, MapDataResponse, OverpassElement } from "../src/types/osm";
import { fromLambert93 } from "../src/lib/data/lambert93";
import { refineBuildingData } from "../src/lib/data/refine-buildings";
import {
  landmarkRefinementProgress,
  landmarkRefinementCandidates,
} from "../src/lib/data/ign-landmark-roofs";
import { refineLandmarkQueue } from "../src/lib/data/refinement-client";
import { validateAssemblyData } from "../src/lib/assembly-project";
import { POST } from "../src/app/api/refine-buildings/route";

// Declared synthetic Nantes site. Flat rasters exercise queue mechanics and
// reconstruction; none of these names, footprints or heights are surveyed data.
const corners = [
  fromLambert93(354000, 6689000),
  fromLambert93(355400, 6690200),
];
const bbox: BBox = [
  corners[0].lat,
  corners[0].lon,
  corners[1].lat,
  corners[1].lon,
];
function source(): MapDataResponse {
  const elements: OverpassElement[] = Array.from({ length: 5 }, (_, index) => {
    const x = 354100 + index * 220,
      y = 6689300;
    return {
      type: "way",
      id: 81000 + index,
      tags: {
        building: "church",
        name: `Édifice de contrôle ${index}`,
        height: "30",
      },
      geometry: [
        [x, y],
        [x + 55, y],
        [x + 55, y + 45],
        [x, y + 45],
        [x, y],
      ].map(([x, y]) => fromLambert93(x, y)),
    };
  });
  // A coarse raster roof is eligible for replacement, unlike a native survey.
  elements[2] = {
    ...elements[2],
    groundElevation: 520,
    roofSurfaces: [
      {
        outer: elements[2].geometry!.map((p) => ({ ...p, elevation: 545 })),
        holes: [],
      },
    ],
    tags: {
      ...elements[2].tags,
      "printmap:roof_reconstruction": "lidar",
      "printmap:roof_resolution_m": "4",
    },
  };
  const surveyed = structuredClone(elements[0]);
  surveyed.id = 82000;
  surveyed.roofSurfaces = [
    {
      outer: surveyed.geometry!.map((p) => ({ ...p, elevation: 550 })),
      holes: [],
    },
  ];
  surveyed.groundElevation = 520;
  surveyed.roofSource = "Contrôle municipal natif synthétique";
  elements.push(surveyed);
  return {
    osmData: { elements },
    elevationGrid: null,
    report: {
      sources: ["Contrôle synthétique"],
      warnings: [],
      fetchedAt: "2026-10-16T00:00:00.000Z",
      areaKm2: 1.68,
      elementCount: elements.length,
      buildingCount: elements.length,
      measuredBuildingCount: 0,
      ignBuildingCount: 0,
      seaCoverage: "unavailable",
      elevationSource: null,
      elevationResolutionM: null,
    },
  };
}

test("a failed relation does not re-enter the queue through a named outer member", () => {
  const data = source();
  const member = data.osmData.elements[0];
  const parent: OverpassElement = {
    type: "relation",
    id: 99000,
    tags: {
      type: "multipolygon",
      building: "church",
      name: "Édifice composé synthétique",
    },
    members: [
      { type: "way", ref: member.id, role: "outer", geometry: member.geometry },
    ],
  };
  const next = data.osmData.elements[1];
  const planned = landmarkRefinementCandidates(
    [parent, member, next],
    bbox,
    undefined,
    {
      allowCoarseLidar: true,
      skipIds: new Set(["relation/99000"]),
    },
  );
  assert.deepEqual(
    planned.selected.map((entry) => `${entry.type}/${entry.id}`),
    [`way/${next.id}`],
  );
});

test("successive real raster reconstruction batches pass two landmarks, replace coarse roofs and never starve the tail after an outage", async (t) => {
  let active = 0,
    maxActive = 0,
    requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (request: string | URL | Request) => {
      const url = new URL(String(request));
      assert.equal(url.hostname, "data.geopf.fr");
      requests++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const [west] = url.searchParams.get("BBOX")!.split(",").map(Number);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (west < 354200) return new Response("outage", { status: 503 });
        const length =
          Number(url.searchParams.get("WIDTH")) *
          Number(url.searchParams.get("HEIGHT"));
        return new Response(
          new Float32Array(length).fill(
            url.searchParams.get("LAYERS")!.includes("MNS") ? 550 : 520,
          ),
          { headers: { "Content-Type": "image/x-bil;bits=32" } },
        );
      } finally {
        active--;
      }
    },
  );
  const original = source(),
    frozen = JSON.stringify(original);
  let data = original,
    batches = 0;
  const counts: number[] = [];
  do {
    data = await refineBuildingData(data, bbox, new AbortController().signal);
    validateAssemblyData(data, bbox);
    counts.push(data.report.landmarkRefinement!.completed);
    assert.ok(
      ++batches <= 4,
      "queue finishes rather than retrying failed priority forever",
    );
  } while (data.report.landmarkRefinement!.remaining);
  assert.equal(batches, 3);
  assert.deepEqual(counts, [1, 3, 4]);
  assert.equal(data.report.landmarkRefinement!.failed, 1);
  assert.equal(data.report.landmarkRefinement!.completed, 4);
  assert.equal(
    data.osmData.elements[4].tags!["printmap:roof_refinement"],
    "landmark",
  );
  assert.equal(
    data.osmData.elements[2].tags!["printmap:roof_resolution_m"],
    "1",
  );
  assert.deepEqual(data.osmData.elements[5], original.osmData.elements[5]);
  assert.equal(data.elevationGrid, original.elevationGrid);
  assert.equal(JSON.stringify(original), frozen);
  assert.ok(maxActive <= 4, "only two MNS/MNT pairs in flight");
  const calls = requests;
  const finished = await refineBuildingData(
    data,
    bbox,
    new AbortController().signal,
  );
  assert.equal(
    requests,
    calls,
    "completed/failed candidates are persisted and skipped",
  );
  assert.equal(finished.report.landmarkRefinement!.remaining, 0);
  const retry = landmarkRefinementProgress(
    data.osmData.elements,
    bbox,
    data.report.landmarkRefinement,
    true,
  );
  assert.equal(
    retry.remaining,
    1,
    "retry revisits an outage without repeating successes",
  );
});

test("progressive client commits each lot before the next request and cancellation preserves completed lots", async (t) => {
  const initial = source();
  initial.report.landmarkRefinement = landmarkRefinementProgress(
    initial.osmData.elements,
    bbox,
  );
  let committed = 0,
    requested = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      assert.equal(committed, requested);
      const { data } = JSON.parse(init.body as string) as {
        data: MapDataResponse;
      };
      requested++;
      data.report.landmarkRefinement!.completed = requested * 2;
      data.report.landmarkRefinement!.remaining = Math.max(
        0,
        5 - requested * 2,
      );
      return Response.json(data);
    },
  );
  const result = await refineLandmarkQueue(
    initial,
    bbox,
    new AbortController().signal,
    {
      onBatch: async () => {
        committed++;
      },
      onProgress: () => {},
    },
  );
  assert.equal(requested, 3);
  assert.equal(result.report.landmarkRefinement!.remaining, 0);
  committed = requested = 0;
  const controller = new AbortController();
  await assert.rejects(
    refineLandmarkQueue(initial, bbox, controller.signal, {
      onBatch: async () => {
        committed++;
        controller.abort();
      },
      onProgress: () => {},
    }),
    { name: "AbortError" },
  );
  assert.equal(committed, 1);
  assert.equal(requested, 1);
});

test("queue import validation bounds identities and states, and the route rejects oversized or malformed work before acquisition", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("must not fetch");
  });
  for (const change of [
    { version: 2 },
    { remaining: -1 },
    { attempts: [{ id: "way/1", outcome: "invented", reason: "wrong" }] },
    { attempts: [{ id: "not-an-osm-id", outcome: "budget", reason: "wrong" }] },
    {
      attempts: Array.from({ length: 2 }, () => ({
        id: "way/1",
        outcome: "budget",
        reason: "duplicate",
      })),
    },
  ]) {
    const data = source();
    data.report.landmarkRefinement = {
      ...landmarkRefinementProgress(data.osmData.elements, bbox),
      ...change,
    } as never;
    assert.throws(() => validateAssemblyData(data), /Progression/);
    const response = await POST(
      new Request("http://localhost/api/refine-buildings", {
        method: "POST",
        body: JSON.stringify({ bbox, data }),
      }),
    );
    assert.equal(response.status, 400);
  }
  const tooLarge = await POST(
    new Request("http://localhost/api/refine-buildings", {
      method: "POST",
      headers: { "content-length": String(33 * 1024 * 1024) },
      body: "{}",
    }),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal(requests, 0);
});
