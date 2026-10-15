import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module, { type Manifold } from "manifold-3d";
import type { Point2D } from "../src/types/geometry";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";
import { applyOceanTerrain } from "../src/lib/mesh/ocean-terrain";
import { createProjectionForBbox } from "../src/lib/projection";
import { geographicPointInRing } from "../src/lib/osm/relation-polygons";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { assertClosedSolid } from "./helpers/solid";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function arena() {
  const handles: { delete(): void }[] = [];
  return {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
    dispose() {
      for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
    },
  };
}
function closed(solid: Manifold) {
  const mesh = solid.getMesh();
  return assertClosedSolid({
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  });
}
function top(solid: Manifold, x: number, y: number) {
  const maximum = solid.boundingBox().max[2];
  const hit = solid.rayCast([x, y, maximum + 1], [x, y, -1])[0];
  assert.ok(hit, `terrain exists at ${x},${y}`);
  return hit.position[2];
}
function area(
  id: number,
  tags: Record<string, string>,
  points: Point2D[],
): OverpassElement {
  return {
    type: "way",
    id,
    tags,
    geometry: [...points, points[0]].map(([lon, lat]) => ({ lon, lat })),
  };
}
const square = (x: number, y: number, half: number): Point2D[] => [
  [x - half, y - half],
  [x + half, y - half],
  [x + half, y + half],
  [x - half, y + half],
];
const ocean: OverpassElement = {
  type: "relation",
  id: 1,
  tags: { natural: "sea", water: "ocean" },
  members: [
    {
      type: "way",
      role: "outer",
      geometry: [
        [-2, -20],
        [20, -20],
        [20, 20],
        [-2, 20],
        [-2, -20],
      ].map(([lon, lat]) => ({ lon, lat })),
    },
    {
      type: "way",
      role: "inner",
      geometry: [...square(4, 0, 1), [3, -1] as Point2D].map(([lon, lat]) => ({
        lon,
        lat,
      })),
    },
  ],
};
const originalAt = (x: number, y: number) => 5 + 0.12 * x + 0.05 * y;

test("only the sea becomes horizontal; an island and all terrain outside its exact mask retain their source volume", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const source = owner.keep(
      owner
        .keep(
          owner.keep(cad.Manifold.cube([20, 20, 1])).translate([-10, -10, 0]),
        )
        .warp((p) => {
          if (p[2] > 0.5) p[2] = originalAt(p[0], p[1]);
        }),
    );
    closed(source);
    const originalVolume = source.volume(),
      clip = owner.keep(cad.CrossSection.square([20, 20], true));
    const result = applyOceanTerrain(cad, owner, {
      elements: [ocean],
      projectMm: (lon, lat) => [lon, lat],
      clip,
      terrainSolid: source,
      surfaceAt: originalAt,
      seaLevelMm: 3,
    });
    assert.ok(result);
    closed(result.solid);
    assert.equal(
      source.volume(),
      originalVolume,
      "the original terrain is immutable",
    );
    assert.equal(result.oceanCount, 1);
    assert.deepEqual(result.sourceIds, ["relation/1"]);
    assert.equal(result.gridEdges.length, result.gridVertices.length);
    for (const [x, y] of [
      [0, -8],
      [8, 7],
      [6, -3],
    ]) {
      assert.equal(result.surfaceAt(x, y), 3);
      assert.ok(Math.abs(top(result.solid, x, y) - 3) < 1e-6);
    }
    for (const [x, y] of [
      [4, 0],
      [-6, 0],
      [-2.001, 6],
    ]) {
      assert.equal(result.surfaceAt(x, y), originalAt(x, y));
      assert.ok(Math.abs(top(result.solid, x, y) - originalAt(x, y)) < 1e-6);
    }
    const outside = owner.keep(
      owner.keep(clip.subtract(result.section)).extrude(20),
    );
    const oldExterior = owner.keep(source.intersect(outside)),
      newExterior = owner.keep(result.solid.intersect(outside));
    assert.ok(owner.keep(oldExterior.subtract(newExterior)).volume() < 1e-8);
    assert.ok(
      owner.keep(newExterior.subtract(oldExterior)).volume() < 1e-8,
      "no fill extends onto land or the island",
    );
    const components = result.solid.decompose();
    assert.equal(components.filter((c) => c.volume() > 0).length, 1);
    components.forEach((c) => c.delete());
  } finally {
    owner.dispose();
  }
});

test("sloping lakes and riverbanks are protected even where a generalized sea mask overlaps them", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const source = owner.keep(
      owner
        .keep(
          owner.keep(cad.Manifold.cube([20, 20, 1])).translate([-10, -10, 0]),
        )
        .warp((p) => {
          if (p[2] > 0.5) p[2] = originalAt(p[0], p[1]);
        }),
    );
    const lake = area(
      2,
      { natural: "water", water: "lake" },
      square(2, 6, 1.5),
    );
    const river = area(3, { waterway: "riverbank" }, [
      [-1, -8],
      [1, -8],
      [1, -3],
      [-1, -3],
    ]);
    const linearRiver: OverpassElement = {
      type: "way",
      id: 4,
      tags: { waterway: "river" },
      geometry: [
        { lon: -8, lat: -8 },
        { lon: -4, lat: 8 },
      ],
    };
    const result = applyOceanTerrain(cad, owner, {
      elements: [ocean, lake, river, linearRiver],
      projectMm: (lon, lat) => [lon, lat],
      clip: owner.keep(cad.CrossSection.square([20, 20], true)),
      terrainSolid: source,
      surfaceAt: originalAt,
      seaLevelMm: 3,
    });
    assert.ok(result);
    closed(result.solid);
    for (const [x, y] of [
      [1.5, 5.5],
      [2.5, 6.5],
      [0, -7],
      [0, -4],
      [-6, 0],
    ]) {
      assert.equal(result.surfaceAt(x, y), originalAt(x, y));
      assert.ok(Math.abs(top(result.solid, x, y) - originalAt(x, y)) < 1e-6);
    }
    assert.notEqual(
      result.surfaceAt(1.5, 5.5),
      result.surfaceAt(2.5, 6.5),
      "lake slope survives",
    );
    assert.notEqual(
      result.surfaceAt(0, -7),
      result.surfaceAt(0, -4),
      "river slope survives",
    );
    assert.equal(result.surfaceAt(7, 6), 3);
  } finally {
    owner.dispose();
  }
});

test("an overlapping marine contour cannot fill another contour's island; an ambiguous bay is not proof of ocean", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const source = owner.keep(
      owner.keep(cad.Manifold.cube([20, 20, 5], true)).translate([0, 0, 2.5]),
    );
    const clip = owner.keep(cad.CrossSection.square([20, 20], true));
    const full = area(5, { natural: "water", water: "ocean" }, [
      [-2, -10],
      [10, -10],
      [10, 10],
      [-2, 10],
    ]);
    const result = applyOceanTerrain(cad, owner, {
      elements: [ocean, full],
      projectMm: (lon, lat) => [lon, lat],
      clip,
      terrainSolid: source,
      surfaceAt: () => 5,
      seaLevelMm: 3,
    });
    assert.ok(result);
    closed(result.solid);
    assert.equal(result.surfaceAt(4, 0), 5);
    assert.equal(top(result.solid, 4, 0), 5);
    const bay = area(6, { natural: "bay" }, square(0, 0, 8));
    assert.equal(
      applyOceanTerrain(cad, owner, {
        elements: [bay],
        projectMm: (lon, lat) => [lon, lat],
        clip,
        terrainSolid: source,
        surfaceAt: () => 5,
        seaLevelMm: 3,
      }),
      null,
    );
  } finally {
    owner.dispose();
  }
});

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/rio-copacabana-ocean.json", import.meta.url),
    "utf8",
  ),
) as {
  bbox: BBox;
  scale: number;
  baseThicknessMm: number;
  elements: OverpassElement[];
  elevationGrid: ElevationGrid;
};

test("real Rio Terrarium ocean spikes are replaced by sea level and the printed solid stays closed without changing the DEM", async () => {
  const cad = await runtime,
    owner = arena(),
    snapshot = JSON.stringify(fixture);
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = true;
  settings.base.basePlateThicknessMm = fixture.baseThicknessMm;
  settings.base.elevationExaggeration = 1;
  settings.base.grid = { cols: 2, rows: 2 };
  const baseline = await buildPrintModel({
    bbox: fixture.bbox,
    scale: fixture.scale,
    osmData: { elements: [] },
    settings,
    elevationGrid: fixture.elevationGrid,
  });
  assertClosedSolid(baseline);
  const projection = createProjectionForBbox(fixture.bbox),
    sf = 1000 / fixture.scale;
  const projectMm = (lon: number, lat: number): Point2D => {
    const [x, y] = projection.project(lon, lat);
    return [x * sf, y * sf];
  };
  try {
    const source = owner.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: baseline.positions,
          triVerts: baseline.indices,
        }),
      ),
    );
    const clip = owner.keep(
      cad.CrossSection.square(
        [baseline.dimensions.widthMm, baseline.dimensions.depthMm],
        true,
      ),
    );
    const sourceAt = (x: number, y: number) => top(source, x, y);
    const level =
      fixture.baseThicknessMm +
      Math.max(0, -fixture.elevationGrid.minElev) * sf;
    const result = applyOceanTerrain(cad, owner, {
      elements: fixture.elements,
      projectMm,
      clip,
      terrainSolid: source,
      surfaceAt: sourceAt,
      seaLevelMm: level,
    });
    assert.ok(result);
    assert.equal(result.solid.status(), "NoError");
    assert.equal(result.oceanCount, 2);
    assert.ok(Math.abs(level - 3.367444) < 1e-5);
    let samples = 0,
      maximumSourceHeight = 0;
    const g = fixture.elevationGrid;
    for (let row = 1; row < g.rows - 1; row += 2)
      for (let col = 1; col < g.cols - 1; col += 2) {
        const lat = g.south + (row / (g.rows - 1)) * (g.north - g.south),
          lon = g.west + (col / (g.cols - 1)) * (g.east - g.west);
        if (
          !fixture.elements.some((e) =>
            e.members!.some(
              (m) =>
                m.role === "outer" &&
                geographicPointInRing({ lat, lon }, m.geometry!),
            ),
          )
        )
          continue;
        const point = projectMm(lon, lat);
        samples++;
        maximumSourceHeight = Math.max(maximumSourceHeight, sourceAt(...point));
        assert.equal(result.surfaceAt(...point), level);
        assert.ok(Math.abs(top(result.solid, ...point) - level) < 1e-5);
      }
    assert.ok(samples > 80);
    assert.ok(
      maximumSourceHeight - level > 5,
      "the real acquired ocean contains over 5mm of false printed relief",
    );
    const cityPoint = projectMm(-43.183, -22.965);
    assert.ok(
      Math.abs(top(result.solid, ...cityPoint) - sourceAt(...cityPoint)) < 1e-5,
    );
    const outside = owner.keep(
      owner
        .keep(clip.subtract(result.section))
        .extrude(baseline.dimensions.heightMm + 1),
    );
    const oldExterior = owner.keep(source.intersect(outside)),
      newExterior = owner.keep(result.solid.intersect(outside));
    assert.ok(owner.keep(oldExterior.subtract(newExterior)).volume() < 1e-5);
    assert.ok(owner.keep(newExterior.subtract(oldExterior)).volume() < 1e-5);
    const components = result.solid.decompose();
    assert.equal(components.filter((c) => c.volume() > 0).length, 1);
    components.forEach((c) => c.delete());
    assert.equal(
      JSON.stringify(fixture),
      snapshot,
      "source contour coordinates, datum and every DEM value stay exact",
    );
    // Exercise the real integration and its existing final export checks. Raw
    // CSG Float32 contacts must pass the ordinary pipeline, never a looser test.
    const complete = await buildPrintModel({
      bbox: fixture.bbox,
      scale: fixture.scale,
      osmData: { elements: fixture.elements },
      settings,
      elevationGrid: fixture.elevationGrid,
    });
    const volume = assertClosedSolid(complete);
    assert.equal(complete.stats.components, 1);
    assert.equal(complete.tiles.length, 4);
    const tileVolume = complete.tiles.reduce(
      (sum, tile) => sum + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
    const exported = owner.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: complete.positions,
          triVerts: complete.indices,
        }),
      ),
    );
    const seaPoint = projectMm(-43.18, -22.972);
    assert.ok(Math.abs(top(exported, ...seaPoint) - level) < 1e-5);
    assert.equal(JSON.stringify(fixture), snapshot);
  } finally {
    owner.dispose();
  }
});
