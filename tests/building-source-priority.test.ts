import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import { parseElements } from "../src/lib/osm/parse-elements";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { BBox, OverpassElement } from "../src/types/osm";
import { PRINT_LAYERS, type PrintMesh } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/saint-etienne-zenith-parts.json", import.meta.url),
    "utf8",
  ),
) as {
  elements: OverpassElement[];
  bbox: BBox;
  scale: number;
  datum: number;
};
const source = fixture.elements.find((element) => element.id === 49047886)!;
const roofPart = fixture.elements.find((element) => element.id === 1271177334)!;

test("real Zenith LiDAR roof supersedes its unmeasured OSM roof part instead of becoming an estimated nine-metre block", () => {
  const parsed = parseElements(fixture.elements, fixture.bbox, fixture.scale);
  const buildings = parsed.buildings;
  assert.equal(parsed.sourceRoofPartIgnoredCount, 1);
  assert.equal(buildings.length, 1);
  assert.equal(buildings[0].sourceId, "way/49047886");
  assert.equal(buildings[0].roofSurfaces, source.roofSurfaces);
  assert.equal(buildings[0].groundElevation, source.groundElevation);
  assert.equal(buildings[0].roofSurfaces?.length, 5);
});

test("declared heights and real 3D parts remain, while LiDAR parts cannot replace a native surveyed envelope", () => {
  const explicit = {
    ...roofPart,
    tags: { ...roofPart.tags, height: "20" },
  };
  assert.deepEqual(
    parseElements(
      [source, explicit],
      fixture.bbox,
      fixture.scale,
    ).buildings.map((building) => building.sourceId),
    ["way/49047886", "way/1271177334"],
  );
  const reconstructedPart = {
    ...roofPart,
    tags: { ...roofPart.tags, "printmap:roof_reconstruction": "lidar" },
    roofSurfaces: source.roofSurfaces,
    groundElevation: source.groundElevation,
  };
  const nativeEnvelope = {
    ...source,
    tags: { ...source.tags, "printmap:roof_reconstruction": "" },
  };
  assert.equal(
    parseElements(
      [nativeEnvelope, reconstructedPart],
      fixture.bbox,
      fixture.scale,
    ).buildings.length,
    2,
    "reconstructed parts do not discard a native source roof",
  );
  assert.deepEqual(
    parseElements(
      [source, reconstructedPart],
      fixture.bbox,
      fixture.scale,
    ).buildings.map((building) => building.sourceId),
    ["way/1271177334"],
    "a complete set of equally documented parts can replace its envelope",
  );
});

test("a part crossing a courtyard or extending outside the source roof remains an ambiguous separate feature", () => {
  const ring = [
    { lat: 45.44, lon: 4.38 },
    { lat: 45.44, lon: 4.3804 },
    { lat: 45.4404, lon: 4.3804 },
    { lat: 45.4404, lon: 4.38 },
    { lat: 45.44, lon: 4.38 },
  ];
  const hole = ring.map((point) => ({
    lat: 45.4401 + (point.lat - 45.44) / 2,
    lon: 4.3801 + (point.lon - 4.38) / 2,
  }));
  const envelope: OverpassElement = {
    type: "relation",
    id: 1,
    tags: { building: "yes", type: "multipolygon" },
    members: [
      { type: "way", ref: 2, role: "outer", geometry: ring },
      { type: "way", ref: 3, role: "inner", geometry: hole },
    ],
    roofSurfaces: [
      {
        outer: ring.map((point) => ({ ...point, elevation: 550 })),
        holes: [hole.map((point) => ({ ...point, elevation: 550 }))],
      },
    ],
    groundElevation: 520,
  };
  const part: OverpassElement = {
    type: "way",
    id: 4,
    tags: { "building:part": "roof" },
    geometry: hole.map((point) => ({ ...point, lat: point.lat + 0.00005 })),
  };
  const parsed = parseElements([envelope, part], fixture.bbox, fixture.scale);
  assert.equal(parsed.buildings.length, 2);
  assert.equal(parsed.buildings[0].polygon.holes.length, 1);
  const outside = {
    ...part,
    geometry: ring.map((point) => ({ ...point, lon: point.lon + 0.0003 })),
  };
  assert.equal(
    parseElements([envelope, outside], fixture.bbox, fixture.scale).buildings
      .length,
    2,
  );
});

type Point = [number, number, number];
type Triangle = [Point, Point, Point];
function upward(mesh: PrintMesh): Triangle[] {
  const output: Triangle[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const triangle = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    ) as Triangle;
    const [a, b, c] = triangle;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-10)
      output.push(triangle);
  }
  return output;
}
function top(triangles: Triangle[], x: number, y: number): number {
  let height = -Infinity;
  for (const [a, b, c] of triangles) {
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      height = Math.max(height, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return height;
}

test("the five actual Zenith roof pans retain their slopes and high silhouette in a closed whole model and four tiles", async () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { rows: 2, cols: 2 };
  const model = await buildPrintModel({
    bbox: fixture.bbox,
    scale: fixture.scale,
    settings,
    osmData: { elements: fixture.elements },
    // Declared synthetic control: the actual whole-city minimum remains the
    // datum, but this test isolates roofs from unrelated neighbourhood relief.
    elevationGrid: {
      rows: 2,
      cols: 2,
      points: Array(4).fill(fixture.datum),
      minElev: fixture.datum,
      maxElev: fixture.datum,
      south: fixture.bbox[0],
      west: fixture.bbox[1],
      north: fixture.bbox[2],
      east: fixture.bbox[3],
      source: "IGN69 datum · declared synthetic flat terrain control",
    },
  });
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.lidarRoofCount, 1);
  assert.equal(model.stats.components, 1);
  assert.ok(
    model.warnings.some((warning) =>
      warning.includes("1 partie(s) sans hauteur"),
    ),
    "omission of the altitude-free overhang is explicitly reported",
  );
  const volume = assertClosedSolid(model);
  assert.equal(model.tiles.length, 4);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
  const sf = 1000 / fixture.scale;
  const { project } = createProjectionForBbox(fixture.bbox);
  const whole = upward(model);
  const tiles = model.tiles.map((tile) => ({ tile, triangles: upward(tile) }));
  const minX = Math.min(
      ...Array.from(model.positions).filter((_, index) => index % 3 === 0),
    ),
    minY = Math.min(
      ...Array.from(model.positions).filter((_, index) => index % 3 === 1),
    );
  let slopes = 0;
  const probes: Point[] = [];
  for (const surface of source.roofSurfaces!) {
    const vertices = surface.outer.slice(0, -1).map((point): Point => {
      const [x, y] = project(point.lon, point.lat);
      return [x * sf, y * sf, 3 + (point.elevation - fixture.datum) * sf];
    });
    const indices = earcut(vertices.flatMap(([x, y]) => [x, y]));
    const triangles: Triangle[] = [];
    for (let at = 0; at < indices.length; at += 3)
      triangles.push(
        indices.slice(at, at + 3).map((index) => vertices[index]) as Triangle,
      );
    const area = ([a, b, c]: Triangle) =>
      Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const triangle = triangles.sort((a, b) => area(b) - area(a))[0];
    assert.ok(triangle);
    const ordered = [...triangle].sort((a, b) => a[2] - b[2]);
    slopes += Number(ordered[2][2] - ordered[0][2] > sf * 0.5);
    for (const weights of [
      [0.6, 0.2, 0.2],
      [0.2, 0.2, 0.6],
    ]) {
      const point = [0, 1, 2].map((axis) =>
        ordered.reduce(
          (sum, vertex, at) => sum + vertex[axis] * weights[at],
          0,
        ),
      ) as Point;
      probes.push(point);
      const tolerance = 0.59 * sf + 0.005;
      assert.ok(
        Math.abs(top(whole, point[0], point[1]) - point[2]) < tolerance,
        `roof point ${point}: actual ${top(whole, point[0], point[1])}, allowed ${tolerance}`,
      );
      let checked = 0;
      for (const { tile, triangles } of tiles) {
        const x0 = minX + tile.col * tile.widthMm,
          y0 = minY + tile.row * tile.depthMm;
        if (
          point[0] < x0 ||
          point[0] > x0 + tile.widthMm ||
          point[1] < y0 ||
          point[1] > y0 + tile.depthMm
        )
          continue;
        assert.ok(
          Math.abs(
            top(
              triangles,
              point[0] - x0 - tile.widthMm / 2,
              point[1] - y0 - tile.depthMm / 2,
            ) - point[2],
          ) < tolerance,
        );
        checked++;
      }
      assert.ok(checked > 0);
    }
  }
  assert.ok(
    slopes >= 4,
    "at least four independently varying real roof pans survive",
  );
  const highest = Math.max(
    ...whole.flatMap((triangle) => triangle.map((point) => point[2])),
  );
  assert.ok(
    Math.abs(highest - (3 + (521.2816457187361 - fixture.datum) * sf)) <
      0.59 * sf + 0.005,
  );
  assert.equal(probes.length, 10);
});
