import assert from "node:assert/strict";
import earcut from "earcut";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BBox, OverpassElement, RoofSurface } from "@/types/osm";
import { fromLambert93, toLambert93 } from "@/lib/data/lambert93";
import {
  MAX_ROOF_BUILDINGS,
  MAX_ROOF_VERTICES,
  validateRoofData,
} from "@/lib/data/validate-roofs";
import {
  conformIGNRoofSurfaces,
  enrichIGNRoofs,
  fetchIGNRoofGrid,
  planIGNRoofGrid,
  reconstructIGNRoof,
  type IGNRoofGrid,
} from "@/lib/data/ign-roofs";

const corner = (x: number, y: number) => fromLambert93(809000 + x, 6484300 + y);
function building(id = 1, courtyard = false): OverpassElement {
  const ring = [
    [2, 2],
    [22, 2],
    [22, 22],
    [2, 22],
    [2, 2],
  ].map(([x, y]) => corner(x, y));
  return courtyard
    ? {
        type: "relation",
        id,
        tags: { building: "yes", type: "multipolygon" },
        members: [
          { type: "way", ref: 10, role: "outer", geometry: ring },
          {
            type: "way",
            ref: 11,
            role: "inner",
            geometry: [
              [8, 8],
              [16, 8],
              [16, 16],
              [8, 16],
              [8, 8],
            ].map(([x, y]) => corner(x, y)),
          },
        ],
      }
    : { type: "way", id, tags: { building: "yes" }, geometry: ring };
}
function grid(z: (x: number, y: number) => number): IGNRoofGrid {
  return {
    west: 809000,
    south: 6484300,
    east: 809024,
    north: 6484324,
    cols: 24,
    rows: 24,
    resolutionM: 1,
    mnt: new Float32Array(24 * 24).fill(520),
    mns: Float32Array.from({ length: 24 * 24 }, (_, k) =>
      z((k % 24) + 0.5, 23.5 - Math.floor(k / 24)),
    ),
  };
}
const tinyBbox: BBox = [45.4491, 4.3961, 45.4493, 4.3964];

function surfaceTriangles(
  s: NonNullable<ReturnType<typeof reconstructIGNRoof>>["surfaces"][number],
) {
  const points: Array<[number, number]> = [],
    holes: number[] = [];
  for (const [index, ring] of [s.outer, ...s.holes].entries()) {
    if (index) holes.push(points.length);
    points.push(...ring.slice(0, -1).map((v) => toLambert93(v.lon, v.lat)));
  }
  const indices = earcut(points.flat(), holes);
  const triangles: Array<Array<[number, number]>> = [];
  for (let i = 0; i < indices.length; i += 3)
    triangles.push([
      points[indices[i]],
      points[indices[i + 1]],
      points[indices[i + 2]],
    ]);
  return triangles;
}
function roofArea(result: NonNullable<ReturnType<typeof reconstructIGNRoof>>) {
  return result.surfaces
    .flatMap(surfaceTriangles)
    .reduce(
      (sum, a) =>
        sum +
        Math.abs(
          (a[1][0] - a[0][0]) * (a[2][1] - a[0][1]) -
            (a[1][1] - a[0][1]) * (a[2][0] - a[0][0]),
        ) /
          2,
      0,
    );
}

test("MNS measured two-sided slope retains absolute altitude and exact footprint", () => {
  const result = reconstructIGNRoof(
    building(),
    grid((x) => 550 + Math.min(x - 2, 22 - x) * 0.4),
  );
  assert.ok(result);
  assert.equal(result.groundElevation, 520);
  assert.ok(result.maxElevation > 553.5 && result.maxElevation < 554.6);
  assert.ok(Math.abs(roofArea(result) - 400) < 0.001);
  assert.ok(result.surfaces.length < 100);
  assert.ok(
    result.surfaces.some(
      (s) =>
        Math.max(...s.outer.map((p) => p.elevation)) -
          Math.min(...s.outer.map((p) => p.elevation)) >
        1,
    ),
  );
});

test("courtyard is not sampled or filled, even with roof-like canopy heights inside the hole", () => {
  const g = grid((x, y) =>
    x > 8 && x < 16 && y > 8 && y < 16 ? 620 : 550 + x * 0.2,
  );
  const result = reconstructIGNRoof(building(2, true), g);
  assert.ok(result);
  assert.ok(Math.abs(roofArea(result) - 336) < 0.001);
  assert.ok(result.maxElevation < 556);
  assert.ok(result.surfaces.some((s) => s.holes.length === 1));
  assert.equal(
    result.triangleCount,
    result.surfaces.flatMap(surfaceTriangles).length,
  );
  for (const coords of result.surfaces.flatMap(surfaceTriangles)) {
    const x = coords.reduce((sum, p) => sum + p[0] - 809000, 0) / coords.length;
    const y =
      coords.reduce((sum, p) => sum + p[1] - 6484300, 0) / coords.length;
    assert.ok(!(x > 8.001 && x < 15.999 && y > 8.001 && y < 15.999));
  }
});

test("no-data and rough vegetation-like surfaces are refused as a whole", () => {
  const absent = grid(() => -99999);
  assert.equal(reconstructIGNRoof(building(), absent), null);
  const rough = grid(
    (x, y) => 550 + ((Math.floor(x) * 17 + Math.floor(y) * 29) % 11),
  );
  assert.equal(reconstructIGNRoof(building(), rough), null);
});

test("absolute altitude limits keep reconstructed roofs compatible with project import", () => {
  const highGround = grid(() => 1120);
  highGround.mnt.fill(1100);
  assert.equal(reconstructIGNRoof(building(), highGround), null);

  const highRoof = grid(() => 1005);
  highRoof.mnt.fill(990);
  assert.equal(reconstructIGNRoof(building(), highRoof), null);

  const valid = grid((x) => 980 + x * 0.2);
  valid.mnt.fill(960);
  const result = reconstructIGNRoof(building(), valid);
  assert.ok(result);
  assert.doesNotThrow(() =>
    validateRoofData([
      {
        ...building(),
        roofSurfaces: result.surfaces,
        groundElevation: result.groundElevation,
      },
    ]),
  );
});

test("native grid bounds memory, dimensions and honest effective spacing", () => {
  const p = planIGNRoofGrid([45.4288, 4.3702, 45.454, 4.406]);
  assert.ok(p.cols * p.rows <= 4_000_000);
  assert.ok(p.cols <= 4096 && p.rows <= 4096);
  assert.ok(p.resolutionM >= 1.5);
  assert.equal(p.resolutionM * 2, Math.floor(p.resolutionM * 2));
  assert.equal(planIGNRoofGrid(tinyBbox).resolutionM, 0.5);
  assert.throws(() => planIGNRoofGrid([NaN, 4, 45, 5]), /Emprise/);
});

test("existing municipal roof/solid has priority and does not trigger a raster request", async () => {
  const element = {
    ...building(),
    roofSurfaces: [{ outer: [], holes: [] }],
    roofSource: "CRAIG 2021",
  };
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  try {
    const r = await enrichIGNRoofs(
      [element],
      tinyBbox,
      new AbortController().signal,
    );
    assert.equal(r.elements[0], element);
    assert.equal(r.buildingCount, 0);
    assert.deepEqual(r.warnings, []);
  } finally {
    globalThis.fetch = before;
  }
});

test("real Parc Expo 2022 raster reconstructs the curved Hall B without a prescribed roof shape", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/saint-etienne-ign-roofs.json", import.meta.url),
      "utf8",
    ),
  );
  const g: IGNRoofGrid = {
    ...fixture.grid,
    mns: Float32Array.from(fixture.grid.mns),
    mnt: Float32Array.from(fixture.grid.mnt),
  };
  const result = reconstructIGNRoof(
    fixture.elements.find((e: OverpassElement) => e.id === 63330323),
    g,
  );
  assert.ok(result);
  assert.ok(result.groundElevation > 492 && result.groundElevation < 493);
  assert.ok(result.maxElevation > 508 && result.maxElevation < 511);
  assert.ok(result.surfaces.length > 20 && result.surfaces.length <= 512);
  const slopes = result.surfaces.map(
    (s) =>
      Math.max(...s.outer.map((v) => v.elevation)) -
      Math.min(...s.outer.map((v) => v.elevation)),
  );
  assert.ok(slopes.filter((z) => z > 0.5).length > 10);
});

test("real Hall A retains the low side volume as well as the shallow main roof", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/saint-etienne-ign-roofs.json", import.meta.url),
      "utf8",
    ),
  );
  const g = {
    ...fixture.grid,
    mns: Float32Array.from(fixture.grid.mns),
    mnt: Float32Array.from(fixture.grid.mnt),
  };
  const result = reconstructIGNRoof(
    fixture.elements.find((e: OverpassElement) => e.id === 750956600),
    g,
  );
  assert.ok(result);
  const heights = result.surfaces.flatMap((s) =>
    s.outer.map((p) => p.elevation),
  );
  assert.ok(Math.min(...heights) < 499 && Math.max(...heights) > 506);
});

test("WMS BIL32 read is exact, uses matched Lambert93 grids and rejects HTTP errors", async () => {
  const before = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const count =
      Number(u.searchParams.get("WIDTH")) *
      Number(u.searchParams.get("HEIGHT"));
    const b = new Uint8Array(count * 4),
      view = new DataView(b.buffer);
    const z = u.searchParams.get("LAYERS")!.includes("MNS") ? 550 : 520;
    for (let i = 0; i < count; i++) view.setFloat32(i * 4, z, true);
    return new Response(b, {
      headers: { "content-type": "image/x-bil;bits=32" },
    });
  };
  try {
    const r = await fetchIGNRoofGrid(tinyBbox, new AbortController().signal);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].searchParams.get("BBOX"),
      calls[1].searchParams.get("BBOX"),
    );
    assert.equal(calls[0].searchParams.get("CRS"), "EPSG:2154");
    assert.equal(r.mns[0], 550);
    assert.equal(r.mnt[0], 520);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(
      fetchIGNRoofGrid(
        [45.45, 4.4, 45.4502, 4.4003],
        new AbortController().signal,
      ),
      /indisponible/,
    );
  } finally {
    globalThis.fetch = before;
  }
});

test("oversized/truncated BIL and cancellation cannot yield fabricated roof data", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(4), {
      headers: { "content-type": "image/x-bil;bits=32" },
    });
  try {
    await assert.rejects(
      fetchIGNRoofGrid(
        [45.451, 4.401, 45.4512, 4.4013],
        new AbortController().signal,
      ),
      /tronqué/,
    );
    globalThis.fetch = async () =>
      new Response(new Uint8Array(4), {
        headers: {
          "content-type": "image/x-bil;bits=32",
          "content-length": "100000000",
        },
      });
    await assert.rejects(
      fetchIGNRoofGrid(
        [45.452, 4.402, 45.4522, 4.4023],
        new AbortController().signal,
      ),
      /volumineux/,
    );
    const c = new AbortController();
    c.abort();
    await assert.rejects(
      enrichIGNRoofs([building()], tinyBbox, c.signal),
      /abort/i,
    );
  } finally {
    globalThis.fetch = before;
  }
});

test("cancellation during WMS download propagates and cancels sibling requests", async () => {
  const before = globalThis.fetch;
  const controller = new AbortController();
  let aborted = 0;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener(
        "abort",
        () => {
          aborted++;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  try {
    const pending = enrichIGNRoofs(
      [building()],
      [45.453, 4.403, 45.4532, 4.4033],
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, /abort/i);
    assert.equal(aborted, 2);
  } finally {
    globalThis.fetch = before;
  }
});

test("uncovered footprint remains unchanged and reports the data gap", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const count =
      Number(u.searchParams.get("WIDTH")) *
      Number(u.searchParams.get("HEIGHT"));
    const b = new Uint8Array(count * 4),
      view = new DataView(b.buffer);
    for (let i = 0; i < count; i++) view.setFloat32(i * 4, -99999, true);
    return new Response(b, {
      headers: { "content-type": "image/x-bil;bits=32" },
    });
  };
  const element = building();
  const p = element.geometry!;
  const bbox: BBox = [
    Math.min(...p.map((v) => v.lat)) - 0.0001,
    Math.min(...p.map((v) => v.lon)) - 0.0001,
    Math.max(...p.map((v) => v.lat)) + 0.0001,
    Math.max(...p.map((v) => v.lon)) + 0.0001,
  ];
  try {
    const result = await enrichIGNRoofs(
      [element],
      bbox,
      new AbortController().signal,
    );
    assert.equal(result.elements[0], element);
    assert.equal(result.buildingCount, 0);
    assert.ok(result.warnings.some((w) => w.includes("suffisamment fiable")));
    assert.deepEqual(result.sources, []);
  } finally {
    globalThis.fetch = before;
  }
});

test("prefetched grid is reused, tags identify reconstruction, and CPU zero does not fabricate data", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must reuse the provided grid");
  };
  try {
    const element = building();
    const r = await enrichIGNRoofs(
      [element],
      tinyBbox,
      new AbortController().signal,
      { grid: grid((x) => 550 + x * 0.2) },
    );
    assert.equal(r.buildingCount, 1);
    assert.equal(r.elements[0].tags?.["printmap:roof_reconstruction"], "lidar");
    assert.equal(r.elements[0].tags?.["printmap:roof_resolution_m"], "1");
    assert.equal(
      r.elements[0].tags?.["printmap:roof_fit_tolerance_m"],
      String(0.35 + 0.12),
    );
    assert.equal(r.elements[0].groundElevation, 520);
    const expired = await enrichIGNRoofs(
      [element],
      tinyBbox,
      new AbortController().signal,
      { grid: grid(() => 550), cpuBudgetMs: 0 },
    );
    assert.equal(expired.elements[0], element);
    assert.equal(expired.buildingCount, 0);
    assert.ok(expired.warnings.some((w) => w.includes("temps de collecte")));
  } finally {
    globalThis.fetch = before;
  }
});

test("underground/negative-layer/zero-level buildings never acquire a visible raster roof", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not acquire underground roofs");
  };
  try {
    const guards: Record<string, string>[] = [
      { location: "underground" },
      { parking: "underground" },
      { layer: "-1" },
      { "building:levels": "0" },
      { "building:levels": "-1" },
    ];
    const elements = guards.map(
      (tags, i) =>
        ({
          ...building(i),
          tags: { building: "yes", ...tags },
        }) as OverpassElement,
    );
    const r = await enrichIGNRoofs(
      elements,
      tinyBbox,
      new AbortController().signal,
    );
    assert.deepEqual(r.elements, elements);
    assert.deepEqual(r.warnings, []);
  } finally {
    globalThis.fetch = before;
  }
});

test("a thin unsampled wing or a footprint outside the acquired grid is not extrapolated", () => {
  const e: OverpassElement = {
    type: "way",
    id: 42,
    tags: { building: "yes" },
    geometry: [
      [2, 2],
      [12, 2],
      [12, 11.8],
      [22, 11.8],
      [22, 12.2],
      [12, 12.2],
      [12, 22],
      [2, 22],
      [2, 2],
    ].map(([x, y]) => corner(x, y)),
  };
  assert.equal(
    reconstructIGNRoof(
      e,
      grid(() => 550),
    ),
    null,
  );
  const outside: OverpassElement = {
    ...building(),
    geometry: [
      [2, 2],
      [32, 2],
      [32, 22],
      [2, 22],
      [2, 2],
    ].map(([x, y]) => corner(x, y)),
  };
  assert.equal(
    reconstructIGNRoof(
      outside,
      grid(() => 550),
    ),
    null,
  );
});

test("LiDAR conformity splits native T-junctions and joins only bounded elevation groups", () => {
  const surface = (ring: number[][], offset: number): RoofSurface => ({
    outer: ring.map(([x, y]) => ({
      ...corner(x, y),
      elevation: 530 + x * 0.2 + offset,
    })),
    holes: [],
  });
  const source = [
    surface(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      0,
    ),
    surface(
      [
        [10, 0],
        [20, 0],
        [20, 5],
        [10, 5],
        [10, 0],
      ],
      0.4,
    ),
    surface(
      [
        [10, 5],
        [20, 5],
        [20, 10],
        [10, 10],
        [10, 5],
      ],
      4,
    ),
  ];
  const original = JSON.stringify(source);
  const result = conformIGNRoofSurfaces(source, 0.59);
  assert.ok(result);
  const atJunction = (s: RoofSurface) =>
    s.outer.filter((p) => {
      const [x, y] = toLambert93(p.lon, p.lat);
      return Math.hypot(x - 809010, y - 6484305) < 0.001;
    });
  const left = atJunction(result[0]),
    low = atJunction(result[1]),
    high = atJunction(result[2]);
  assert.equal(left.length, 1);
  assert.equal(left[0].elevation, low[0].elevation);
  assert.equal(left[0].lon, high[0].lon);
  assert.equal(left[0].lat, high[0].lat);
  assert.ok(Math.abs(left[0].elevation - 532.2) < 1e-6);
  assert.equal(high[0].elevation, 536);
  assert.equal(JSON.stringify(source), original);
  assert.equal(conformIGNRoofSurfaces(source, NaN), null);
});

test("LiDAR conformity preserves an explicit courtyard and refuses malformed open rings", () => {
  const roof = reconstructIGNRoof(
    building(2, true),
    grid((x) => 550 + x * 0.2),
  );
  assert.ok(roof);
  const result = conformIGNRoofSurfaces(roof.surfaces, 0.47);
  assert.ok(result);
  assert.equal(result.flatMap((s) => s.holes).length, 1);
  assert.ok(Math.abs(roofArea({ ...roof, surfaces: result }) - 336) < 0.001);
  const broken = roof.surfaces.map((s) => ({
    ...s,
    outer: s.outer.slice(0, -1),
  }));
  assert.equal(conformIGNRoofSurfaces(broken, 0.47), null);
});

test("real Hall A/B conformity stays inside the measured footprint and the fit threshold", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/saint-etienne-ign-roofs.json", import.meta.url),
      "utf8",
    ),
  );
  const g: IGNRoofGrid = {
    ...fixture.grid,
    mns: Float32Array.from(fixture.grid.mns),
    mnt: Float32Array.from(fixture.grid.mnt),
  };
  for (const element of fixture.elements) {
    const roof = reconstructIGNRoof(element, g);
    assert.ok(roof);
    const result = conformIGNRoofSurfaces(roof.surfaces, 0.59);
    assert.ok(result);
    assert.ok(
      Math.abs(roofArea({ ...roof, surfaces: result }) - roofArea(roof)) < 0.01,
    );
    const previous = roof.surfaces.flatMap((s) => [s.outer, ...s.holes]).flat();
    for (const vertex of previous) {
      const [x, y] = toLambert93(vertex.lon, vertex.lat);
      const matches = result
        .flatMap((s) => [s.outer, ...s.holes])
        .flat()
        .filter((p) => {
          const xy = toLambert93(p.lon, p.lat);
          return Math.hypot(xy[0] - x, xy[1] - y) <= 0.001;
        });
      assert.ok(
        matches.some((p) => Math.abs(p.elevation - vertex.elevation) <= 0.59),
      );
    }
  }
});

test("existing roof/solid import budgets include holes and closures and take priority over new LiDAR", async () => {
  const rectangle = [
    [2, 2],
    [22, 2],
    [22, 22],
    [2, 22],
  ];
  const denseRing = (count: number) => {
    const points = Array.from({ length: count - 1 }, (_, i) => {
      const side = (i * 4) / (count - 1),
        edge = Math.floor(side),
        t = side - edge;
      const a = rectangle[edge],
        b = rectangle[(edge + 1) % 4];
      return {
        ...corner(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t),
        elevation: 550,
      };
    });
    points.push({ ...points[0] });
    return points;
  };
  const hole = [
    [8, 8],
    [16, 8],
    [16, 16],
    [8, 16],
    [8, 8],
  ].map(([x, y]) => ({ ...corner(x, y), elevation: 550 }));
  const square = denseRing(5),
    ground = square.map((p) => ({ ...p, elevation: 520 }));
  const groundHole = hole.map((p) => ({ ...p, elevation: 520 }));
  const walls = [square, hole].flatMap((ring) =>
    ring.slice(0, -1).map((a, i) => {
      const b = ring[i + 1];
      return {
        kind: "wall" as const,
        outer: [a, b, { ...b, elevation: 520 }, { ...a, elevation: 520 }, a],
        holes: [],
      };
    }),
  );
  // 19×20,000 + (19,931 outer + 5 hole) + 60 complete solid vertices = 399,996.
  const dense = denseRing(20000);
  const priors: OverpassElement[] = Array.from({ length: 19 }, (_, i) => ({
    ...building(100 + i),
    roofSurfaces: [{ outer: dense, holes: [] }],
    groundElevation: 520,
    roofSource: "synthetic import-budget fixture",
  }));
  priors.push({
    ...building(200),
    groundElevation: 520,
    roofSurfaces: [{ outer: denseRing(19931), holes: [hole] }],
    measuredSolid: {
      source: "synthetic closed courtyard solid",
      year: 2021,
      surfaces: [
        { kind: "roof", outer: square, holes: [hole] },
        { kind: "ground", outer: ground, holes: [groundHole] },
        ...walls,
      ],
    },
  });
  const vertices = priors.reduce(
    (n, e) =>
      n +
      [...e.roofSurfaces!, ...(e.measuredSolid?.surfaces ?? [])].reduce(
        (sum, s) =>
          sum +
          s.outer.length +
          s.holes.reduce((a, ring) => a + ring.length, 0),
        0,
      ),
    0,
  );
  assert.equal(vertices, MAX_ROOF_VERTICES - 4);
  assert.doesNotThrow(() => validateRoofData(priors));
  const candidate = building();
  const result = await enrichIGNRoofs(
    [...priors, candidate],
    tinyBbox,
    new AbortController().signal,
    { grid: grid(() => 550) },
  );
  assert.equal(result.buildingCount, 0);
  assert.equal(result.elements.at(-1), candidate);
  assert.ok(priors.every((e, i) => result.elements[i] === e));
  assert.ok(
    result.warnings.some((w) => w.includes("budgets de géométrie et d’import")),
  );
  assert.ok(!result.warnings.some((w) => w.includes("suffisamment fiable")));
  assert.doesNotThrow(() => validateRoofData(result.elements));

  const many = Array.from({ length: MAX_ROOF_BUILDINGS }, (_, i) => ({
    ...building(1000 + i),
    roofSurfaces: [{ outer: square, holes: [] }],
    groundElevation: 520,
  }));
  assert.doesNotThrow(() => validateRoofData(many));
  const countLimited = await enrichIGNRoofs(
    [...many, candidate],
    tinyBbox,
    new AbortController().signal,
    { grid: grid(() => 550) },
  );
  assert.equal(countLimited.buildingCount, 0);
  assert.equal(countLimited.elements.at(-1), candidate);
  assert.ok(
    countLimited.warnings.some((w) =>
      w.includes("budgets de géométrie et d’import"),
    ),
  );
  assert.doesNotThrow(() => validateRoofData(countLimited.elements));
});

test("a heavy supported footprint obeys a short CPU deadline and observes cancellation before publication", async () => {
  const geometry = Array.from({ length: 255 }, (_, i) => {
    const angle = (i / 255) * Math.PI * 2;
    return fromLambert93(
      809176 + 169 * Math.cos(angle),
      6484476 + 169 * Math.sin(angle),
    );
  });
  geometry.push({ ...geometry[0] });
  const element: OverpassElement = {
    type: "way",
    id: 1,
    tags: { building: "yes" },
    geometry,
  };
  const heavy: IGNRoofGrid = {
    west: 809000,
    south: 6484300,
    east: 809352,
    north: 6484652,
    cols: 352,
    rows: 352,
    resolutionM: 1,
    mnt: new Float32Array(352 * 352).fill(520),
    mns: new Float32Array(352 * 352).fill(550),
  };
  assert.equal(
    reconstructIGNRoof(element, heavy, undefined, () => false),
    null,
  );
  const started = performance.now();
  const result = await enrichIGNRoofs(
    [element],
    tinyBbox,
    new AbortController().signal,
    { grid: heavy, cpuBudgetMs: 50 },
  );
  assert.ok(
    performance.now() - started < 500,
    "short budget must not complete the roughly two-second footprint",
  );
  assert.equal(result.elements[0], element);
  assert.equal(result.buildingCount, 0);
  assert.ok(result.warnings.some((w) => w.includes("limite du temps CPU")));
  assert.ok(!result.warnings.some((w) => w.includes("suffisamment fiable")));

  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, 25);
  try {
    await assert.rejects(
      enrichIGNRoofs([element], tinyBbox, controller.signal, {
        grid: heavy,
        cpuBudgetMs: 50,
      }),
      /abort/i,
    );
    assert.equal(fired, true);
    assert.equal(element.roofSurfaces, undefined);
  } finally {
    clearTimeout(timer);
  }
});
