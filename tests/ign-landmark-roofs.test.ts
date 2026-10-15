import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { fromLambert93 } from "@/lib/data/lambert93";
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
    roofSurfaces: Array.from({ length: 20 }, (): RoofSurface => ({
      outer: ring,
      holes: [],
    })),
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
