import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCityJSONBuildings } from "../src/lib/data/cityjson-parser";
import type { BBox, OverpassElement } from "../src/types/osm";

const source = "CRAIG - FEDER Auvergne-Rhône-Alpes - 2021 · Bâti3D LoD2.2";
const bbox: BBox = [45.4288, 4.3702, 45.454, 4.406];
const fixturePath = new URL(
  "./fixtures/saint-etienne-craig-cityjson.json",
  import.meta.url,
);

test("Saint-Étienne collection preserves CRAIG roofs and distinguishes LiDAR reconstructions outside its coverage", async () => {
  const document = JSON.parse(await readFile(fixturePath, "utf8")).document;
  const raw = JSON.stringify(document);
  const parsed = parseCityJSONBuildings(document, { source, year: 2021 });
  assert.ok(parsed.buildings.length >= 3);
  const old: OverpassElement = {
    type: "way",
    id: 81,
    tags: { building: "yes", height: "10" },
    geometry: parsed.buildings[0].footprints[0].outer,
  };
  const outside: OverpassElement = {
    type: "way",
    id: 82,
    tags: { building: "yes", height: "12" },
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
  const temporary = await mkdtemp(join(tmpdir(), "printmap-craig-collection-"));
  process.chdir(temporary);
  let downloads = 0,
    mode = "success";
  let controller: AbortController | undefined;
  globalThis.fetch = async (request, options) => {
    const url = String(request);
    if (url.includes("drive.opendata.craig.fr")) {
      downloads++;
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        "Basic b3BlbmRhdGE6",
      );
      if (mode === "oversized")
        return new Response("", {
          headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
        });
      if (mode === "invalid") return new Response("not CityJSON");
      if (mode === "abort") {
        return new Response(
          new ReadableStream({
            start(stream) {
              controller!.abort(new Error("user cancelled roofs"));
              stream.enqueue(new TextEncoder().encode(raw));
              stream.close();
            },
          }),
        );
      }
      return new Response(raw);
    }
    if (url.includes("overpass"))
      return Response.json({ elements: [old, outside] });
    if (url.includes("data.geopf.fr/wfs"))
      return Response.json({ features: [], numberMatched: 0 });
    if (url.includes("data.geopf.fr/wms-r/wms")) {
      const parameters = new URL(url).searchParams;
      const count =
        Number(parameters.get("WIDTH")) * Number(parameters.get("HEIGHT"));
      const value = parameters.get("LAYERS")?.includes("MNS") ? 532 : 520;
      return new Response(new Float32Array(count).fill(value), {
        headers: { "Content-Type": "image/x-bil;bits=32" },
      });
    }
    return new Response("unused public provider", { status: 503 });
  };
  try {
    // Resolve after changing cwd so every cache file belongs to this test only.
    const { fetchCRAIGBuildings } =
      await import("../src/lib/data/craig-buildings");
    const { collectMapData } = await import("../src/lib/data/collect");
    const result = await collectMapData(bbox, false, AbortSignal.timeout(5000));
    assert.equal(downloads, 1);
    assert.equal(result.report.lod2Year, 2021);
    assert.ok(result.report.lod2BuildingCount! >= 3);
    assert.ok(
      result.report.sources.some(
        (item) => item.includes("CRAIG") && item.includes("Licence Ouverte"),
      ),
    );
    assert.ok(
      result.report.warnings.some((item) =>
        item.includes("Badouillière–Chavanelle"),
      ),
    );
    assert.ok(
      !result.osmData.elements.some((element) => element.id === old.id),
    );
    const reconstructed = result.osmData.elements.find(
      (element) => element.id === outside.id,
    )!;
    assert.ok(reconstructed.roofSurfaces?.length);
    assert.equal(reconstructed.tags!["printmap:roof_reconstruction"], "lidar");
    assert.equal(reconstructed.tags!["printmap:roof_year"], undefined);
    assert.equal(result.report.lidarRoofBuildingCount, 1);
    assert.ok(result.report.lidarRoofSurfaceCount! > 0);
    assert.ok(result.report.lidarRoofResolutionM! >= 1.5);
    assert.equal(result.report.lod2BuildingCount, parsed.buildings.length);
    assert.ok(
      result.report.sources.some((item) => item.includes("IGN LiDAR HD")),
    );
    const measured = result.osmData.elements.find(
      (element) => element.roofSource === source,
    )!;
    assert.equal(measured.roofSource, source);
    assert.match(measured.tags!["printmap:source_id"], /^CRAIG\/2021\//);
    assert.equal(measured.tags!["printmap:roof_year"], "2021");
    const cached = await fetchCRAIGBuildings(bbox, AbortSignal.timeout(5000));
    assert.equal(
      downloads,
      1,
      "a second selection must reuse the validated source cache",
    );
    assert.equal(cached.buildings.length, parsed.buildings.length);
    const empty = await fetchCRAIGBuildings(
      [45.448, 4.394, 45.451, 4.399],
      AbortSignal.timeout(5000),
    );
    assert.equal(
      empty.covered,
      false,
      "Expo is not covered by the semantic CRAIG district",
    );
    assert.equal(downloads, 1);
    const preAbort = new AbortController();
    preAbort.abort(new Error("cancel before roofs"));
    await assert.rejects(
      fetchCRAIGBuildings(bbox, preAbort.signal),
      /cancel before roofs/,
    );
    const cache = join(
      temporary,
      ".cache",
      "printmap",
      "craig-st-etienne-2021-v1.json.gz",
    );
    for (mode of ["oversized", "invalid"]) {
      await writeFile(cache, "corrupt test cache");
      const fallback = await fetchCRAIGBuildings(
        bbox,
        AbortSignal.timeout(5000),
      );
      assert.deepEqual(fallback.buildings, []);
      assert.ok(
        fallback.warnings.some((warning) => warning.includes("indisponible")),
      );
    }
    await writeFile(cache, "corrupt test cache");
    mode = "abort";
    controller = new AbortController();
    await assert.rejects(
      fetchCRAIGBuildings(bbox, controller.signal),
      /user cancelled roofs/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(cwd);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("CityJSON rejects unknown coordinates and preserves the fallback when a courtyard or semantic roof is invalid", async () => {
  const document = JSON.parse(await readFile(fixturePath, "utf8")).document;
  const metadata = { source, year: 2021 };
  assert.throws(
    () =>
      parseCityJSONBuildings(
        { ...document, metadata: { referenceSystem: "EPSG:4326" } },
        metadata,
      ),
    /projection/,
  );
  assert.throws(
    () =>
      parseCityJSONBuildings(
        {
          ...document,
          transform: { ...document.transform, scale: [0, 0.001, 0.001] },
        },
        metadata,
      ),
    /Transformation/,
  );
  const expected = parseCityJSONBuildings(document, metadata);
  const bad = structuredClone(document);
  const [id, object] = Object.entries(bad.CityObjects)[0] as [
    string,
    { geometry: { type: string; boundaries: number[][][] }[] },
  ];
  const surface = object.geometry.find(
    (geometry) => geometry.type === "MultiSurface",
  )!;
  surface.boundaries[0][0][0] = bad.vertices.length + 1;
  const actual = parseCityJSONBuildings(bad, metadata);
  assert.equal(actual.buildings.length, expected.buildings.length - 1);
  assert.ok(!actual.buildings.some((building) => building.id === id));
  assert.equal(actual.skippedBuildingCount, expected.skippedBuildingCount + 1);
});
