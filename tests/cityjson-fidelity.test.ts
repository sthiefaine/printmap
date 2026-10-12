import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import { parseCityJSONBuildings } from "../src/lib/data/cityjson-parser";
import { fromLambert93, toLambert93 } from "../src/lib/data/lambert93";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { PRINT_LAYERS, type PrintMesh } from "../src/types/print";
import type { BBox, OverpassElement } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

type Point3 = [number, number, number];
type SemanticGeometry = {
  type: string;
  boundaries: number[][][];
  semantics?: {
    surfaces: { type: string }[];
    values: number[];
  };
};
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/saint-etienne-craig-cityjson.json", import.meta.url),
    "utf8",
  ),
) as {
  provenance: { source: string; year: number; buildingIds: string[] };
  scale: number;
  datumElevation: number;
  sourceVertexIndices: number[];
  document: {
    transform: { scale: Point3; translate: Point3 };
    vertices: Point3[];
    CityObjects: Record<string, { geometry: SemanticGeometry[] }>;
  };
  expected: Record<
    string,
    {
      roofCount: number;
      groundElevation: number;
      ridgeElevation?: number;
      eaveElevation?: number;
      groundHoles?: number;
      roofHoles?: number;
      levels?: number[];
    }
  >;
};
const metadata = {
  source: fixture.provenance.source,
  year: fixture.provenance.year,
};
const nativePoint = (index: number): Point3 =>
  fixture.document.vertices[index].map(
    (coordinate, axis) =>
      coordinate * fixture.document.transform.scale[axis] +
      fixture.document.transform.translate[axis],
  ) as Point3;
function nativeFaces(id: string, kind: string) {
  const geometry = fixture.document.CityObjects[id].geometry.find(
    (geometry) => geometry.type === "MultiSurface",
  )!;
  return geometry.boundaries.filter(
    (_, at) =>
      geometry.semantics!.surfaces[geometry.semantics!.values[at]].type ===
      kind,
  );
}

/** Read the exported upward faces, independently of the survey triangulation. */
function topAt(mesh: PrintMesh, x: number, y: number, buildingsOnly = true) {
  let maximum = -Infinity;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (buildingsOnly && PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings")
      continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(at, at + 3), (index) =>
      Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)),
    );
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (determinant <= 1e-12) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      maximum = Math.max(maximum, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return maximum;
}

/** Triangulate only native source rings; the parser and roof builder are unused. */
function sourceTriangles(face: number[][]) {
  const points = face.flatMap((ring) => ring.map(nativePoint));
  let count = face[0].length;
  const holes = face.slice(1).map((ring) => {
    const start = count;
    count += ring.length;
    return start;
  });
  const [originX, originY] = points[0];
  const triangles = earcut(
    points.flatMap(([x, y]) => [x - originX, y - originY]),
    holes,
  );
  const result: Point3[][] = [];
  for (let at = 0; at < triangles.length; at += 3)
    result.push(triangles.slice(at, at + 3).map((index) => points[index]));
  return result.sort((a, b) => triangleArea(b) - triangleArea(a));
}
function triangleArea([a, b, c]: Point3[]) {
  return (
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
  );
}
const barycentre = (triangle: Point3[], weights = [1 / 3, 1 / 3, 1 / 3]) =>
  [0, 1, 2].map((axis) =>
    triangle.reduce((sum, point, at) => sum + point[axis] * weights[at], 0),
  ) as Point3;

test("CRAIG CityJSON preserves exact Lambert-93/IGN69 rings and semantic roofs without duplicating its unlabelled Solid", () => {
  const { buildings, skippedBuildingCount } = parseCityJSONBuildings(
    fixture.document,
    metadata,
  );
  assert.equal(skippedBuildingCount, 0);
  assert.deepEqual(
    buildings.map((building) => building.id),
    fixture.provenance.buildingIds,
  );
  assert.equal(fixture.document.vertices.length, 175);
  assert.equal(new Set(fixture.sourceVertexIndices).size, 175);
  for (const building of buildings) {
    const expected = fixture.expected[building.id];
    const nativeRoofs = nativeFaces(building.id, "RoofSurface");
    assert.equal(building.roofSurfaces.length, expected.roofCount);
    assert.ok(
      Math.abs(building.groundElevation - expected.groundElevation) < 1e-9,
    );
    assert.equal(building.measuredSolid, undefined);
    for (let panel = 0; panel < nativeRoofs.length; panel++) {
      const output = building.roofSurfaces[panel];
      const rings = [output.outer, ...output.holes];
      assert.equal(rings.length, nativeRoofs[panel].length);
      for (let ring = 0; ring < rings.length; ring++) {
        const native = nativeRoofs[panel][ring];
        // CityJSON rings do not repeat their first index. Normalised rings do.
        assert.equal(rings[ring].length, native.length + 1);
        assert.deepEqual(rings[ring][0], rings[ring].at(-1));
        for (let at = 0; at < native.length; at++) {
          const [x, y, z] = nativePoint(native[at]);
          const point = rings[ring][at];
          const [parsedX, parsedY] = toLambert93(point.lon, point.lat);
          assert.ok(Math.abs(parsedX - x) < 0.00001);
          assert.ok(Math.abs(parsedY - y) < 0.00001);
          assert.equal(point.elevation, z);
        }
      }
    }
    const nativeGround = nativeFaces(building.id, "GroundSurface");
    assert.equal(building.footprints.length, nativeGround.length);
    for (let ground = 0; ground < nativeGround.length; ground++) {
      const polygon = building.footprints[ground];
      const rings = [polygon.outer, ...polygon.holes];
      for (let ring = 0; ring < rings.length; ring++) {
        assert.equal(rings[ring].length, nativeGround[ground][ring].length + 1);
        for (let at = 0; at < nativeGround[ground][ring].length; at++) {
          const [x, y] = nativePoint(nativeGround[ground][ring][at]);
          const point = rings[ring][at];
          const [parsedX, parsedY] = toLambert93(point.lon, point.lat);
          assert.ok(Math.abs(parsedX - x) < 0.00001);
          assert.ok(Math.abs(parsedY - y) < 0.00001);
        }
      }
    }
    assert.equal(
      building.footprints.reduce(
        (sum, polygon) => sum + polygon.holes.length,
        0,
      ),
      expected.groundHoles ?? 0,
    );
    assert.equal(
      building.roofSurfaces.reduce((sum, panel) => sum + panel.holes.length, 0),
      expected.roofHoles ?? 0,
    );
  }
  // Put the unlabelled Solid first: source order must not replace semantics.
  const reversed = structuredClone(fixture.document);
  for (const object of Object.values(reversed.CityObjects))
    object.geometry.reverse();
  assert.deepEqual(parseCityJSONBuildings(reversed, metadata), {
    buildings,
    skippedBuildingCount,
  });
});

for (const scale of [fixture.scale, 13036.65]) {
  test(`CRAIG source heights and its courtyard survive 1:${scale}, four tiles and a discarded underground part`, async () => {
    const { buildings } = parseCityJSONBuildings(fixture.document, metadata);
    const allPoints = buildings.flatMap((building) =>
      building.footprints.flatMap((polygon) => polygon.outer),
    );
    const bbox: BBox = [
      Math.min(...allPoints.map((point) => point.lat)) - 0.0002,
      Math.min(...allPoints.map((point) => point.lon)) - 0.0002,
      Math.max(...allPoints.map((point) => point.lat)) + 0.0002,
      Math.max(...allPoints.map((point) => point.lon)) + 0.0002,
    ];
    const elements: OverpassElement[] = buildings.flatMap((building, at) =>
      building.footprints.map((polygon, part) => ({
        type: "relation" as const,
        id: -3000000000000 - at * 100 - part,
        tags: {
          building: "yes",
          height: String(building.height),
          "printmap:source": metadata.source,
          "printmap:source_id": `CRAIG/${building.id}`,
        },
        groundElevation: building.groundElevation,
        roofSurfaces: building.roofSurfaces,
        roofSource: metadata.source,
        members: [
          { type: "way", role: "outer", geometry: polygon.outer },
          ...polygon.holes.map((geometry) => ({
            type: "way",
            role: "inner",
            geometry,
          })),
        ],
      })),
    );
    // This synthetic basement copies a real support contour and the museum's
    // offending OSM tags. Its excessive explicit height makes the exclusion
    // observable even above our controlled flat datum. It is not survey data.
    elements.push({
      type: "way",
      id: -9000000000000,
      tags: {
        "building:part": "yes",
        "building:levels": "0",
        layer: "-1",
        height: "80",
      },
      geometry: buildings[0].footprints[0].outer,
    });
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    settings.base.grid = { rows: 2, cols: 2 };
    const model = await buildPrintModel({
      bbox,
      scale,
      osmData: { elements },
      settings,
      // A controlled flat IGN69 datum isolates surveyed roofs from terrain error.
      // This is explicitly synthetic, not an acquired Saint-Étienne terrain grid.
      elevationGrid: {
        rows: 2,
        cols: 2,
        points: Array(4).fill(fixture.datumElevation),
        minElev: fixture.datumElevation,
        maxElev: fixture.datumElevation,
        south: bbox[0],
        west: bbox[1],
        north: bbox[2],
        east: bbox[3],
        source:
          "IGN69 datum · synthetic flat grid for the CityJSON fidelity test",
      },
    });
    const sf = 1000 / scale;
    const retainedIds = fixture.provenance.buildingIds.filter(
      (id) =>
        nativeFaces(id, "GroundSurface")
          .flatMap(sourceTriangles)
          .reduce(
            (area, triangle) => area + triangleArea(triangle) * sf * sf,
            0,
          ) >= settings.print.minBuildingAreaMm2,
    );
    assert.equal(retainedIds.length, scale === fixture.scale ? 3 : 2);
    assert.equal(model.stats.buildingCount, retainedIds.length);
    assert.equal(model.stats.realRoofCount, retainedIds.length);
    if (scale !== fixture.scale) {
      assert.equal(model.stats.discardedFeatures, 1);
      assert.ok(model.warnings.some((warning) => /trop petits/.test(warning)));
    }
    assert.equal(model.stats.components, 1);
    assert.ok(
      !model.warnings.some((warning) =>
        /repli|incomplète.*toiture/i.test(warning),
      ),
    );
    const volume = assertClosedSolid(model);
    assert.equal(model.tiles.length, 4);
    const tileVolume = model.tiles.reduce(
      (sum, tile) => sum + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);

    const projection = createProjectionForBbox(bbox);
    const printPoint = ([x, y, z]: Point3): Point3 => {
      const geo = fromLambert93(x, y);
      const [px, py] = projection.project(geo.lon, geo.lat);
      return [
        px * sf,
        py * sf,
        settings.base.basePlateThicknessMm + (z - fixture.datumElevation) * sf,
      ];
    };
    let minX = Infinity,
      minY = Infinity;
    for (let at = 0; at < model.positions.length; at += 3) {
      minX = Math.min(minX, model.positions[at]);
      minY = Math.min(minY, model.positions[at + 1]);
    }
    let tileProbes = 0;
    function checkSourceHeight(source: Point3, label: string) {
      const [x, y, z] = printPoint(source);
      assert.ok(
        Math.abs(topAt(model, x, y) - z) < 0.01,
        `${label} in the whole model`,
      );
      for (const tile of model.tiles) {
        const x0 = minX + tile.col * tile.widthMm;
        const y0 = minY + tile.row * tile.depthMm;
        if (
          x >= x0 - 1e-5 &&
          x <= x0 + tile.widthMm + 1e-5 &&
          y >= y0 - 1e-5 &&
          y <= y0 + tile.depthMm + 1e-5
        ) {
          assert.ok(
            Math.abs(
              topAt(
                tile,
                x - x0 - tile.widthMm / 2,
                y - y0 - tile.depthMm / 2,
              ) - z,
            ) < 0.01,
            `${label} in tile ${tile.col},${tile.row}`,
          );
          tileProbes++;
        }
      }
    }
    // Every pan gets an interior sample from independently triangulated native
    // XYZ rings. Uniform height extrusion cannot pass the pitched roof samples.
    for (const id of retainedIds) {
      const faces = nativeFaces(id, "RoofSurface");
      for (let panel = 0; panel < faces.length; panel++) {
        const triangle = sourceTriangles(faces[panel])[0];
        checkSourceHeight(barycentre(triangle), `${id} roof panel ${panel}`);
        if (id === "1003794.00") {
          const low = triangle.findIndex(
            (point) => point[2] === Math.min(...triangle.map((p) => p[2])),
          );
          const high = triangle.findIndex(
            (point) => point[2] === Math.max(...triangle.map((p) => p[2])),
          );
          checkSourceHeight(
            barycentre(
              triangle,
              [0, 1, 2].map((at) => (at === low ? 0.8 : 0.1)),
            ),
            `${id} near eave ${panel}`,
          );
          checkSourceHeight(
            barycentre(
              triangle,
              [0, 1, 2].map((at) => (at === high ? 0.8 : 0.1)),
            ),
            `${id} near ridge ${panel}`,
          );
        }
      }
      const sourceRoofPoints = faces.flatMap((face) =>
        face.flatMap((ring) => ring.map(nativePoint)),
      );
      const expected = fixture.expected[id];
      if (expected.ridgeElevation != null)
        assert.ok(
          Math.abs(
            Math.max(...sourceRoofPoints.map((point) => point[2])) -
              expected.ridgeElevation,
          ) < 1e-9,
        );
      if (expected.eaveElevation != null)
        assert.ok(
          sourceRoofPoints.some(
            (point) => Math.abs(point[2] - expected.eaveElevation!) < 1e-9,
          ),
        );
      if (expected.levels)
        assert.deepEqual(
          [
            ...new Set(
              sourceRoofPoints.map((point) => Number(point[2].toFixed(6))),
            ),
          ].sort((a, b) => a - b),
          expected.levels,
        );
    }
    assert.ok(
      tileProbes >=
        retainedIds.reduce(
          (sum, id) => sum + fixture.expected[id].roofCount,
          0,
        ) +
          10,
      "the measured heights are also sampled from exported tile buffers",
    );
    const courtyard = nativeFaces("1003321.00", "GroundSurface")[0][1];
    const [courtX, courtY] = printPoint(
      barycentre(sourceTriangles([courtyard])[0]),
    );
    assert.equal(
      topAt(model, courtX, courtY),
      -Infinity,
      "the real ground courtyard has no building above it",
    );
    assert.ok(
      Math.abs(
        topAt(model, courtX, courtY, false) -
          settings.base.basePlateThicknessMm,
      ) < 0.00001,
      "the courtyard exposes the controlled terrain, not a filled roof",
    );
    let courtyardTiles = 0;
    for (const tile of model.tiles) {
      const x0 = minX + tile.col * tile.widthMm;
      const y0 = minY + tile.row * tile.depthMm;
      if (
        courtX >= x0 &&
        courtX <= x0 + tile.widthMm &&
        courtY >= y0 &&
        courtY <= y0 + tile.depthMm
      ) {
        const x = courtX - x0 - tile.widthMm / 2;
        const y = courtY - y0 - tile.depthMm / 2;
        assert.equal(topAt(tile, x, y), -Infinity);
        assert.ok(
          Math.abs(
            topAt(tile, x, y, false) - settings.base.basePlateThicknessMm,
          ) < 0.00001,
          "the courtyard remains open in the containing tile",
        );
        courtyardTiles++;
      }
    }
    assert.ok(courtyardTiles > 0);
    assert.ok(
      Math.abs(model.dimensions.heightMm - printPoint([0, 0, 565.073472])[2]) <
        0.01,
    );
  });
}

test("a measured CRAIG terrace replaces higher terrain only inside its actual support, preserving the courtyard and exterior", async () => {
  const id = "1003321.00";
  const building = parseCityJSONBuildings(
    fixture.document,
    metadata,
  ).buildings.find((building) => building.id === id)!;
  const allPoints = building.footprints.flatMap((polygon) => polygon.outer);
  const bbox: BBox = [
    Math.min(...allPoints.map((point) => point.lat)) - 0.0004,
    Math.min(...allPoints.map((point) => point.lon)) - 0.0004,
    Math.max(...allPoints.map((point) => point.lat)) + 0.0004,
    Math.max(...allPoints.map((point) => point.lon)) + 0.0004,
  ];
  const elements: OverpassElement[] = building.footprints.map(
    (polygon, part) => ({
      type: "relation",
      id: -3000000001000 - part,
      tags: {
        building: "yes",
        height: String(building.height),
        "printmap:source": metadata.source,
        "printmap:source_id": `CRAIG/${id}`,
      },
      groundElevation: building.groundElevation,
      roofSurfaces: building.roofSurfaces,
      roofSource: metadata.source,
      members: [
        { type: "way", role: "outer", geometry: polygon.outer },
        ...polygon.holes.map((geometry) => ({
          type: "way",
          role: "inner",
          geometry,
        })),
      ],
    }),
  );
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.grid = { rows: 2, cols: 2 };
  const scale = fixture.scale;
  const sf = 1000 / scale;
  // This deliberately conflicting terrain is synthetic, not acquired LiDAR.
  // Its plateau covers the real support, courtyard and exterior test point,
  // hiding three authentic low terraces before the terrain is replaced locally.
  // One distant corner keeps the declared minimum equal to an actual grid value.
  const terrainElevation = 534;
  const points = Array(25).fill(terrainElevation);
  points[0] = fixture.datumElevation;
  const model = await buildPrintModel({
    bbox,
    scale,
    osmData: { elements },
    settings,
    elevationGrid: {
      rows: 5,
      cols: 5,
      points,
      minElev: fixture.datumElevation,
      maxElev: terrainElevation,
      south: bbox[0],
      west: bbox[1],
      north: bbox[2],
      east: bbox[3],
      source: "IGN69 datum · synthetic terrain above the CRAIG terrace test",
    },
  });
  assert.equal(model.stats.buildingCount, 1);
  assert.equal(model.stats.realRoofCount, 1);
  assert.equal(model.stats.components, 1);
  assert.equal(model.tiles.length, 4);
  const volume = assertClosedSolid(model);
  const tileVolume = model.tiles.reduce(
    (sum, tile) => sum + assertClosedSolid(tile),
    0,
  );
  assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
  const projection = createProjectionForBbox(bbox);
  const printPoint = ([x, y, z]: Point3): Point3 => {
    const geo = fromLambert93(x, y);
    const [px, py] = projection.project(geo.lon, geo.lat);
    return [
      px * sf,
      py * sf,
      settings.base.basePlateThicknessMm + (z - fixture.datumElevation) * sf,
    ];
  };
  let minX = Infinity,
    minY = Infinity;
  for (let at = 0; at < model.positions.length; at += 3) {
    minX = Math.min(minX, model.positions[at]);
    minY = Math.min(minY, model.positions[at + 1]);
  }
  let tileProbes = 0;
  const checkVisibleHeight = (
    source: Point3,
    label: string,
    terrain = false,
  ) => {
    const [x, y, z] = printPoint(source);
    const tolerance = terrain ? 0.00001 : 0.01;
    // All layers are sampled: a correct building face hidden below the DEM
    // cannot satisfy visibility, even if the roof itself was never discarded.
    assert.ok(
      Math.abs(topAt(model, x, y, false) - z) < tolerance,
      `${label} is visible in the whole model`,
    );
    if (terrain) assert.equal(topAt(model, x, y), -Infinity, label);
    let containingTiles = 0;
    for (const tile of model.tiles) {
      const x0 = minX + tile.col * tile.widthMm;
      const y0 = minY + tile.row * tile.depthMm;
      if (
        x >= x0 &&
        x <= x0 + tile.widthMm &&
        y >= y0 &&
        y <= y0 + tile.depthMm
      ) {
        const tx = x - x0 - tile.widthMm / 2;
        const ty = y - y0 - tile.depthMm / 2;
        assert.ok(
          Math.abs(topAt(tile, tx, ty, false) - z) < tolerance,
          `${label} is visible in tile ${tile.col},${tile.row}`,
        );
        if (terrain) assert.equal(topAt(tile, tx, ty), -Infinity, label);
        containingTiles++;
        tileProbes++;
      }
    }
    assert.ok(containingTiles > 0, `${label} has a containing tile`);
  };
  const roofs = nativeFaces(id, "RoofSurface");
  let lowPanels = 0;
  for (let panel = 0; panel < roofs.length; panel++) {
    const source = barycentre(sourceTriangles(roofs[panel])[0]);
    if (source[2] < terrainElevation) lowPanels++;
    checkVisibleHeight(source, `${id} native roof panel ${panel}`);
  }
  assert.equal(
    lowPanels,
    3,
    "three genuine terraces lie below the synthetic DEM",
  );
  const ground = nativeFaces(id, "GroundSurface")[0];
  assert.equal(ground.length, 2, "the source retains its actual courtyard");
  const court = barycentre(sourceTriangles([ground[1]])[0]);
  checkVisibleHeight(
    [court[0], court[1], terrainElevation],
    "the actual courtyard retains the original high terrain",
    true,
  );
  const support = ground[0].map(nativePoint);
  checkVisibleHeight(
    [
      Math.max(...support.map((point) => point[0])) + 10,
      (Math.min(...support.map((point) => point[1])) +
        Math.max(...support.map((point) => point[1]))) /
        2,
      terrainElevation,
    ],
    "terrain ten metres outside the support remains unchanged",
    true,
  );
  assert.ok(tileProbes >= roofs.length + 2);
});
