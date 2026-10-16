import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BBox, OverpassElement, RoofSurface } from "@/types/osm";
import {
  conformIGNRoofSurfaces,
  enrichIGNRoofs,
  reconstructIGNRoof,
  type IGNRoofGrid,
} from "@/lib/data/ign-roofs";
import {
  decimateIGNRoofGrid,
  enrichIGNLandmarkRoofs,
  fetchIGNLandmarkRoofGrids,
} from "@/lib/data/ign-landmark-roofs";
import { fromLambert93, toLambert93 } from "@/lib/data/lambert93";
import { validateRoofData } from "@/lib/data/validate-roofs";

const directory = new URL("./fixtures/", import.meta.url);
const fixture = JSON.parse(
  readFileSync(new URL("saint-etienne-landmark-roofs.json", directory), "utf8"),
) as {
  buildings: Array<{
    element: OverpassElement;
    grid: Omit<IGNRoofGrid, "mns" | "mnt"> & {
      mnsFile: string;
      mntFile: string;
    };
  }>;
};
const bil = (filename: string) => {
  const bytes = readFileSync(new URL(filename, directory));
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    bytes.readFloatLE(index * 4),
  );
};
const entries = fixture.buildings.map(({ element, grid }) => ({
  element,
  grid: {
    ...grid,
    mns: bil(grid.mnsFile),
    mnt: bil(grid.mntFile),
  } as IGNRoofGrid,
}));
const elements = entries.map((entry) => entry.element);
const grids = new Map(
  entries.map((entry) => [`way/${entry.element.id}`, entry.grid]),
);
const bbox: BBox = [45.4288, 4.3702, 45.4628, 4.406];

test("decimation retains original BIL heights and exact sample centres, including odd grid dimensions", () => {
  const original = entries[0].grid;
  const sampled = decimateIGNRoofGrid(original);
  assert.equal(sampled.resolutionM, 1);
  assert.equal(sampled.cols, 90);
  assert.equal(sampled.rows, 53);
  for (let row = 0; row < sampled.rows; row++)
    for (let col = 0; col < sampled.cols; col++) {
      const oldIndex: number = row * 2 * original.cols + col * 2;
      const sampledIndex: number = row * sampled.cols + col;
      assert.equal(sampled.mns[sampledIndex], original.mns[oldIndex]);
      assert.equal(sampled.mnt[sampledIndex], original.mnt[oldIndex]);
      assert.equal(
        sampled.west + col + 0.5,
        original.west + (col * 2 + 0.5) * 0.5,
      );
      assert.equal(
        sampled.north - row - 0.5,
        original.north - (row * 2 + 0.5) * 0.5,
      );
    }
  assert.throws(() => decimateIGNRoofGrid(original, 1.5), /invalide/);
});

test("real Saint-Charles and Sainte-Marie roofs use clipped source support without weakening default budgets or quality", () => {
  const expected = [
    {
      pans: 1270,
      triangles: 2660,
      ground: 515.0011596679688,
      top: 557.4156264955571,
    },
    {
      pans: 1208,
      triangles: 2534,
      ground: 523.8185424804688,
      top: 552.5566946908573,
    },
  ];
  for (const [index, entry] of entries.entries()) {
    const grid = decimateIGNRoofGrid(entry.grid);
    assert.equal(reconstructIGNRoof(entry.element, grid), null);
    const roof = reconstructIGNRoof(entry.element, grid, undefined, undefined, {
      landmark: true,
    });
    assert.ok(roof);
    assert.equal(roof.surfaces.length, expected[index].pans);
    assert.equal(roof.triangleCount, expected[index].triangles);
    assert.ok(Math.abs(roof.groundElevation - expected[index].ground) < 0.001);
    assert.ok(Math.abs(roof.maxElevation - expected[index].top) < 0.001);
    assert.ok(
      roof.surfaces.some((surface) => {
        const z = surface.outer.map((point) => point.elevation);
        return Math.max(...z) - Math.min(...z) > 1;
      }),
    );
    assert.equal(conformIGNRoofSurfaces(roof.surfaces, 0.47), null);
    assert.ok(conformIGNRoofSurfaces(roof.surfaces, 0.47, { landmark: true }));
    const absent = {
      ...grid,
      mns: new Float32Array(grid.mns.length).fill(-99999),
    };
    assert.equal(
      reconstructIGNRoof(entry.element, absent, undefined, undefined, {
        landmark: true,
      }),
      null,
    );
  }
});

test("local landmark enrichment publishes truthful 1 m provenance and leaves native roofs untouched", async (t) => {
  // Test geometry independently of runner speed. The real CPU deadline and
  // cancellation have their own test below; production's 4 s cap is unchanged.
  t.mock.method(Date, "now", () => 1_000_000);
  const result = await enrichIGNLandmarkRoofs(
    elements,
    bbox,
    new AbortController().signal,
    {
      grids,
    },
  );
  assert.equal(result.buildingCount, 2);
  assert.equal(result.triangleCount, 5194);
  assert.equal(result.surfaceCount, 2478);
  assert.equal(result.resolutionM, 1);
  for (const element of result.elements) {
    assert.equal(element.tags!["printmap:roof_refinement"], "landmark");
    assert.equal(element.tags!["printmap:roof_resolution_m"], "1");
    assert.equal(element.tags!["printmap:roof_fit_tolerance_m"], "0.47");
    assert.equal(element.tags!["printmap:roof_year"], undefined);
  }
  assert.equal(result.elements[0].tags!.height, "42.41");
  assert.equal(result.elements[1].tags!.height, "28.74");
  validateRoofData(result.elements);
  const preserved = await enrichIGNLandmarkRoofs(
    result.elements,
    bbox,
    new AbortController().signal,
  );
  assert.equal(preserved.buildingCount, 0);
  assert.equal(preserved.elements, result.elements);
  const reserved = await enrichIGNRoofs(
    result.elements,
    bbox,
    new AbortController().signal,
    {
      grid: entries[0].grid,
      maxTriangles: 0,
    },
  );
  assert.equal(reserved.buildingCount, 0);
  assert.equal(reserved.elements, result.elements);
  assert.ok(reserved.warnings.some((warning) => warning.includes("réservé")));
});

test("landmark enrichment shares the import vertex budget with existing primary geometry", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const ring = Array.from({ length: 19998 }, (_, index) => {
    const angle = (index / 19998) * Math.PI * 2;
    return {
      ...fromLambert93(
        809000 + Math.cos(angle) * 10,
        6484300 + Math.sin(angle) * 10,
      ),
      elevation: 550,
    };
  });
  ring.push({ ...ring[0] });
  const primary: OverpassElement = {
    type: "way",
    id: 999,
    groundElevation: 520,
    roofSurfaces: Array.from(
      { length: 20 },
      (): RoofSurface => ({
        outer: ring,
        holes: [],
      }),
    ),
    tags: {
      building: "yes",
      "printmap:source_id": "native/near-import-budget",
    },
  };
  const input = [primary, ...elements];
  validateRoofData(input);
  const result = await enrichIGNLandmarkRoofs(
    input,
    bbox,
    new AbortController().signal,
    { grids },
  );
  assert.equal(result.buildingCount, 0);
  assert.equal(result.elements[0], primary);
  assert.ok(result.warnings.some((warning) => warning.includes("budgets")));
  validateRoofData(result.elements);
});

test("progressive refinement charges total LiDAR budget net of the coarse roofs being replaced", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const coarse = elements.map((element) => ({
    ...element,
    tags: {
      ...element.tags,
      "printmap:roof_reconstruction": "lidar",
      "printmap:roof_resolution_m": "4",
    },
    groundElevation: 520,
    roofSurfaces: [
      {
        outer: element.geometry!.map((point) => ({ ...point, elevation: 540 })),
        holes: [],
      },
    ],
  }));
  const source = JSON.stringify(coarse);
  const result = await enrichIGNLandmarkRoofs(
    coarse,
    bbox,
    new AbortController().signal,
    {
      grids,
      allowCoarseLidar: true,
      maxTotalLidarTriangles: 5194,
    },
  );
  assert.equal(result.buildingCount, 2);
  assert.equal(result.triangleCount, 5194);
  assert.deepEqual(result.attempts, []);
  assert.equal(JSON.stringify(coarse), source);
  const tooSmall = await enrichIGNLandmarkRoofs(
    coarse,
    bbox,
    new AbortController().signal,
    {
      grids,
      allowCoarseLidar: true,
      maxTotalLidarTriangles: 1,
    },
  );
  assert.equal(tooSmall.buildingCount, 0);
  assert.equal(tooSmall.attempts.length, 2);
  assert.ok(tooSmall.attempts.every((entry) => entry.outcome === "budget"));
  assert.equal(tooSmall.elements[0], coarse[0]);
});

test("landmark CPU deadline and cancellation are observed before publishing geometry", async () => {
  const short = await enrichIGNLandmarkRoofs(
    elements,
    bbox,
    new AbortController().signal,
    {
      grids,
      cpuBudgetMs: 1,
    },
  );
  assert.equal(short.buildingCount, 0);
  assert.ok(short.warnings.some((warning) => warning.includes("temps CPU")));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(
      enrichIGNLandmarkRoofs(elements, bbox, controller.signal, { grids }),
      { name: "AbortError" },
    );
  } finally {
    clearTimeout(timer);
  }
});

test("collection reserves refined triangles, reports mixed spacing, and preserves CRAIG measured geometry", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const document = JSON.parse(
    readFileSync(
      new URL("saint-etienne-craig-cityjson.json", directory),
      "utf8",
    ),
  ).document;
  const { parseCityJSONBuildings } = await import("@/lib/data/cityjson-parser");
  const source = "CRAIG - FEDER Auvergne-Rhône-Alpes - 2021 · Bâti3D LoD2.2";
  const parsed = parseCityJSONBuildings(document, { source, year: 2021 });
  const old: OverpassElement = {
    type: "way",
    id: 81,
    tags: { building: "yes" },
    geometry: parsed.buildings[0].footprints[0].outer,
  };
  const outside: OverpassElement = {
    type: "way",
    id: 82,
    tags: { building: "yes" },
    geometry: [
      { lat: 45.449, lon: 4.398 },
      { lat: 45.449, lon: 4.3983 },
      { lat: 45.4492, lon: 4.3983 },
      { lat: 45.4492, lon: 4.398 },
      { lat: 45.449, lon: 4.398 },
    ],
  };
  const previousFetch = globalThis.fetch,
    cwd = process.cwd();
  const temporary = await mkdtemp(
    join(tmpdir(), "printmap-landmark-collection-"),
  );
  process.chdir(temporary);
  let localCalls = 0;
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.includes("drive.opendata.craig.fr")) return Response.json(document);
    if (url.includes("overpass"))
      return Response.json({ elements: [...elements, old, outside] });
    if (url.includes("data.geopf.fr/wfs"))
      return Response.json({ features: [], numberMatched: 0 });
    if (url.includes("data.geopf.fr/wms-r/wms")) {
      const parameters = new URL(url).searchParams;
      const width = Number(parameters.get("WIDTH")),
        height = Number(parameters.get("HEIGHT"));
      const local = entries.find(
        ({ grid }) => grid.cols === width && grid.rows === height,
      );
      const mns = parameters.get("LAYERS")!.includes("MNS");
      if (local) {
        localCalls++;
        return new Response(
          Float32Array.from(mns ? local.grid.mns : local.grid.mnt).buffer,
          {
            headers: { "Content-Type": "image/x-bil;bits=32" },
          },
        );
      }
      return new Response(
        new Float32Array(width * height).fill(mns ? 550 : 520),
        { headers: { "Content-Type": "image/x-bil;bits=32" } },
      );
    }
    return new Response("unused public provider", { status: 503 });
  };
  try {
    const { collectMapData } = await import("@/lib/data/collect");
    const result = await collectMapData(
      bbox,
      false,
      AbortSignal.timeout(10000),
    );
    assert.equal(
      localCalls,
      4,
      "two local MNS/MNT acquisitions, no repeated fetch during enrichment",
    );
    assert.equal(result.report.landmarkRoofBuildingCount, 2);
    assert.equal(result.report.lidarRoofMinResolutionM, 1);
    assert.equal(result.report.lidarRoofResolutionM, 2);
    assert.equal(result.report.lidarRoofBuildingCount, 3);
    assert.equal(result.report.lod2Year, 2021);
    const measured = result.osmData.elements.find(
      (element) =>
        element.tags?.["printmap:source_id"] ===
        `CRAIG/2021/${parsed.buildings[0].id}`,
    )!;
    assert.deepEqual(measured.roofSurfaces, parsed.buildings[0].roofSurfaces);
    assert.equal(measured.tags!["printmap:roof_reconstruction"], undefined);
    const refined = result.osmData.elements.filter(
      (element) => element.tags?.["printmap:roof_refinement"] === "landmark",
    );
    assert.equal(refined.length, 2);
    assert.ok(refined.every((element) => Number(element.tags!.height) > 25));
    assert.ok(result.report.sources.some((value) => value.includes("CRAIG")));
    assert.ok(
      result.report.sources.some((value) => value.includes("IGN LiDAR HD")),
    );
    validateRoofData(result.osmData.elements);
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(cwd);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local acquisition preserves geometry and avoids calls for already measured or unrelated catalogue landmarks", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchIGNLandmarkRoofGrids(elements, bbox, controller.signal),
    { name: "AbortError" },
  );
  const alreadyMeasured = elements.map((element) => ({
    ...element,
    roofSurfaces: [
      {
        outer: element.geometry!.map((point) => ({ ...point, elevation: 550 })),
        holes: [],
      },
    ],
    groundElevation: 520,
  }));
  const result = await fetchIGNLandmarkRoofGrids(
    alreadyMeasured,
    bbox,
    new AbortController().signal,
  );
  assert.equal(result.grids.size, 0);
  assert.deepEqual(result.warnings, []);
});

function uncatalogued(index: number, id = 91000 + index) {
  const entry = entries[index];
  return {
    ...entry,
    element: {
      ...structuredClone(entry.element),
      id,
      tags: {
        building: "church",
        amenity: "place_of_worship",
        name: `Église de contrôle hors catalogue ${id}`,
        height: String(20 + index),
      },
    } as OverpassElement,
  };
}

/** Real BIL values, translated geometry solely to exercise a different city's
 * selection. This is a synthetic test location, never published survey data. */
function translated(index: number, id: number, dx: number, dy: number) {
  const entry = uncatalogued(index, id);
  entry.element.geometry = entry.element.geometry!.map((point) => {
    const [x, y] = toLambert93(point.lon, point.lat);
    return fromLambert93(x + dx, y + dy);
  });
  entry.grid = {
    ...entry.grid,
    west: entry.grid.west + dx,
    east: entry.grid.east + dx,
    south: entry.grid.south + dy,
    north: entry.grid.north + dy,
  };
  return entry;
}

function mockRaster(t: TestContext) {
  const requests: URL[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (request: string | URL | Request) => {
      const url = new URL(String(request));
      requests.push(url);
      assert.match(url.hostname, /^data\.geopf\.fr$/);
      const width = Number(url.searchParams.get("WIDTH")),
        height = Number(url.searchParams.get("HEIGHT"));
      assert.ok(width * height <= 250000);
      return new Response(
        new Float32Array(width * height).fill(
          url.searchParams.get("LAYERS")!.includes("MNS") ? 550 : 520,
        ),
        { headers: { "Content-Type": "image/x-bil;bits=32" } },
      );
    },
  );
  return requests;
}

test("local refinement intersects building material even when no mapped corner is selected", async (t) => {
  const requests = mockRaster(t);
  const ring = (south: number, west: number, north: number, east: number) => [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
    { lat: south, lon: west },
  ];
  // Synthetic Paris location, roughly 110 m × 73 m; no invented source geometry
  // is published. The native local raster remains under the 250,000 pixel budget.
  const outer = ring(48.8555, 2.3005, 48.8565, 2.3015);
  const church: OverpassElement = {
    type: "way",
    id: 98001,
    tags: { building: "church", name: "Église de contrôle" },
    geometry: outer,
  };
  const inside: BBox = [48.856, 2.301, 48.8562, 2.3012];
  const crossing: BBox = [48.8559, 2.3004, 48.8561, 2.3016];
  const covering: BBox = [48.8554, 2.3004, 48.8566, 2.3016];
  for (const selection of [inside, crossing, covering]) {
    const result = await fetchIGNLandmarkRoofGrids(
      [church],
      selection,
      new AbortController().signal,
    );
    assert.deepEqual([...result.grids.keys()], ["way/98001"]);
  }
  assert.ok(requests.length >= 2);

  const courtyard: OverpassElement = {
    type: "relation",
    id: 98002,
    tags: { type: "multipolygon", ...church.tags },
    members: [
      { type: "way", role: "outer", geometry: outer },
      {
        type: "way",
        role: "inner",
        geometry: ring(48.8558, 2.3008, 48.8563, 2.3013),
      },
    ],
  };
  for (const selection of [
    inside,
    // A rectangle exactly matching the courtyard is still empty of material.
    [48.8558, 2.3008, 48.8563, 2.3013] as BBox,
    [48.8566, 2.3006, 48.8568, 2.3008] as BBox,
  ]) {
    const before = requests.length;
    const result = await fetchIGNLandmarkRoofGrids(
      [courtyard],
      selection,
      new AbortController().signal,
    );
    assert.equal(result.grids.size, 0);
    assert.equal(requests.length, before);
  }
  const acrossCourtyard = await fetchIGNLandmarkRoofGrids(
    [courtyard],
    crossing,
    new AbortController().signal,
  );
  assert.deepEqual([...acrossCourtyard.grids.keys()], ["relation/98002"]);

  const cShape: OverpassElement = {
    ...church,
    id: 98003,
    geometry: [
      [0, 0],
      [1, 0],
      [1, 0.2],
      [0.2, 0.2],
      [0.2, 0.8],
      [1, 0.8],
      [1, 1],
      [0, 1],
      [0, 0],
    ].map(([x, y]) => ({ lat: 48.8555 + y * 0.001, lon: 2.3005 + x * 0.001 })),
  };
  const beforeNotch = requests.length;
  const notch = await fetchIGNLandmarkRoofGrids(
    [cShape],
    [48.8559, 2.3009, 48.8561, 2.3011],
    new AbortController().signal,
  );
  assert.equal(notch.grids.size, 0, "a concave notch is not building material");
  assert.equal(requests.length, beforeNotch);
  const disconnected = await fetchIGNLandmarkRoofGrids(
    [cShape],
    [48.8554, 2.3011, 48.8566, 2.3013],
    new AbortController().signal,
  );
  assert.deepEqual(
    [...disconnected.grids.keys()],
    ["way/98003"],
    "the rectangle crosses two wings, with no building vertex inside",
  );
});

test("real roof fixtures with unknown OSM IDs refine named churches without the Saint-Étienne catalogue", async (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const local = [uncatalogued(0), uncatalogued(1)];
  const result = await enrichIGNLandmarkRoofs(
    local.map((e) => e.element),
    bbox,
    new AbortController().signal,
    { grids: new Map(local.map((e) => [keyOf(e.element), e.grid])) },
  );
  assert.equal(result.buildingCount, 2);
  assert.equal(result.triangleCount, 5194);
  assert.equal(result.surfaceCount, 2478);
  assert.ok(
    result.elements.every(
      (e) => e.tags?.["printmap:roof_refinement"] === "landmark",
    ),
  );
  assert.ok(
    result.elements.every((e) =>
      e.tags?.name?.startsWith("Église de contrôle hors catalogue"),
    ),
  );
  validateRoofData(result.elements);
});

const keyOf = (element: OverpassElement) => `${element.type}/${element.id}`;

test("the same real samples also refine uncatalogued geometry at a synthetic location in another French city", async (t) => {
  t.mock.method(Date, "now", () => 1000000);
  // Lambert-93 translation to Nantes. Altitudes remain fixture values, not a
  // claim that these buildings or heights exist at this synthetic location.
  const local = [
    translated(0, 92001, -453000, 196000),
    translated(1, 92002, -453000, 196000),
  ];
  const points = local.flatMap((e) => e.element.geometry!);
  const anotherCity: BBox = [
    Math.min(...points.map((p) => p.lat)) - 0.001,
    Math.min(...points.map((p) => p.lon)) - 0.001,
    Math.max(...points.map((p) => p.lat)) + 0.001,
    Math.max(...points.map((p) => p.lon)) + 0.001,
  ];
  assert.ok(
    anotherCity[1] < 0,
    "the regression is outside Saint-Étienne and its catalogue coverage",
  );
  const result = await enrichIGNLandmarkRoofs(
    local.map((e) => e.element),
    anotherCity,
    new AbortController().signal,
    { grids: new Map(local.map((e) => [keyOf(e.element), e.grid])) },
  );
  assert.equal(result.buildingCount, 2);
  assert.ok(result.triangleCount <= 8192);
  assert.ok(Math.abs(Number(result.elements[0].tags?.height) - 42.41) < 0.05);
  assert.ok(Math.abs(Number(result.elements[1].tags?.height) - 28.74) < 0.05);
  validateRoofData(result.elements);
});

test("prefetched grids outrank changed heights so enrichment never discards already acquired local data", async (t) => {
  t.mock.method(Date, "now", () => 1000000);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("prefetched grids must not trigger network calls");
  });
  const local = [uncatalogued(0), uncatalogued(1)];
  const taller = [
    uncatalogued(0, 93001).element,
    uncatalogued(1, 93002).element,
  ];
  taller[0].tags!.height = "250";
  taller[1].tags!.height = "200";
  const result = await enrichIGNLandmarkRoofs(
    [...taller, ...local.map((e) => e.element)],
    bbox,
    new AbortController().signal,
    { grids: new Map(local.map((e) => [keyOf(e.element), e.grid])) },
  );
  assert.equal(result.buildingCount, 2);
  assert.equal(result.triangleCount, 5194);
  assert.equal(result.elements[0], taller[0]);
  assert.equal(result.elements[1], taller[1]);
  assert.ok(result.elements.slice(2).every((e) => e.roofSurfaces?.length));
});

test("native surveys added after prefetch remain untouched while the other available grid still refines", async (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const local = [uncatalogued(0), uncatalogued(1)];
  const surveyed = {
    ...local[0].element,
    roofSurfaces: [
      {
        outer: local[0].element.geometry!.map((p) => ({
          ...p,
          elevation: 550,
        })),
        holes: [],
      },
    ],
    groundElevation: 520,
  };
  const taller = [
    uncatalogued(0, 94001).element,
    uncatalogued(1, 94002).element,
  ];
  taller.forEach((e) => {
    e.tags!.height = "300";
  });
  const result = await enrichIGNLandmarkRoofs(
    [surveyed, ...taller, local[1].element],
    bbox,
    new AbortController().signal,
    { grids: new Map(local.map((e) => [keyOf(e.element), e.grid])) },
  );
  assert.equal(result.buildingCount, 1);
  assert.equal(result.elements[0], surveyed);
  assert.ok(result.elements.at(-1)?.roofSurfaces?.length);
});

test("generic local acquisition stays at two buildings and deduplicates named relation members", async (t) => {
  const requests = mockRaster(t);
  const member = uncatalogued(0, 95001).element;
  const relation: OverpassElement = {
    type: "relation",
    id: 95002,
    tags: { ...member.tags, name: "Cathédrale relation", height: "100" },
    members: [
      { type: "way", ref: member.id, role: "outer", geometry: member.geometry },
    ],
  };
  const other = uncatalogued(1, 95003).element;
  other.tags!.height = "80";
  const omitted = uncatalogued(0, 95004).element;
  omitted.tags!.height = "60";
  const result = await fetchIGNLandmarkRoofGrids(
    [member, omitted, relation, other],
    bbox,
    new AbortController().signal,
  );
  assert.equal(result.grids.size, 2);
  assert.deepEqual([...result.grids.keys()].sort(), [
    "relation/95002",
    "way/95003",
  ]);
  assert.ok(requests.length <= 4, "two bounded local MNS/MNT pairs");
});

test("invalid plans, excessive vertices and nonlocal native rasters are skipped without blocking a valid landmark", async (t) => {
  mockRaster(t);
  const valid = uncatalogued(1, 96001).element;
  const malformed = uncatalogued(0, 96002).element;
  const p = malformed.geometry![0];
  malformed.geometry = [
    p,
    { lat: p.lat, lon: 11 },
    { lat: p.lat + 0.01, lon: 11 },
    p,
  ];
  const excessive = uncatalogued(0, 96003).element;
  excessive.geometry = Array.from(
    { length: 10001 },
    (_, index) => excessive.geometry![index % excessive.geometry!.length],
  );
  excessive.geometry[10000] = excessive.geometry[0];
  const huge = uncatalogued(0, 96004).element;
  huge.geometry = [
    p,
    { lat: p.lat, lon: p.lon + 0.01 },
    { lat: p.lat + 0.01, lon: p.lon + 0.01 },
    { lat: p.lat + 0.01, lon: p.lon },
    p,
  ];
  const excessiveRelation: OverpassElement = {
    type: "relation",
    id: 96005,
    tags: { building: "church", name: "Relation trop détaillée" },
    members: [
      {
        type: "way",
        ref: excessive.id,
        role: "outer",
        geometry: excessive.geometry,
      },
    ],
  };
  const result = await fetchIGNLandmarkRoofGrids(
    [malformed, excessive, huge, excessiveRelation, valid],
    bbox,
    new AbortController().signal,
  );
  assert.deepEqual([...result.grids.keys()], ["way/96001"]);
});

test("Rio, anonymous buildings, native roofs and members of measured relations never request refinement", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("an ineligible source cannot request IGN");
  });
  const unknown = uncatalogued(0, 97001).element;
  const rio: BBox = [-22.94, -43.2, -22.9, -43.16];
  const foreign = await fetchIGNLandmarkRoofGrids(
    [unknown],
    rio,
    new AbortController().signal,
  );
  assert.equal(foreign.grids.size, 0);
  const anonymous = { ...unknown, id: 97002, tags: { building: "church" } };
  const member = uncatalogued(1, 97003).element;
  const roof = {
    outer: member.geometry!.map((p) => ({ ...p, elevation: 550 })),
    holes: [],
  };
  const relation: OverpassElement = {
    type: "relation",
    id: 97004,
    tags: { building: "church", name: "Église relevée" },
    roofSurfaces: [roof],
    groundElevation: 520,
    members: [
      { type: "way", ref: member.id, role: "outer", geometry: member.geometry },
    ],
  };
  const measured = { ...unknown, roofSurfaces: [roof], groundElevation: 520 };
  const result = await fetchIGNLandmarkRoofGrids(
    [anonymous, member, relation, measured],
    bbox,
    new AbortController().signal,
  );
  assert.equal(result.grids.size, 0);
  assert.equal(fetch.mock.callCount(), 0);
});
