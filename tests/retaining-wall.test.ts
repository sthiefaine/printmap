import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold } from "manifold-3d";
import { readFileSync } from "node:fs";
import { makeMappedRetainingWall } from "../src/lib/mesh/mapped-retaining-wall";
import { sampleElevation } from "../src/lib/elevation/sample-grid";
import { createProjectionForBbox } from "../src/lib/projection";
import type { BBox, ElevationGrid, OverpassResponse } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function arena() {
  const handles: { delete(): void }[] = [];
  return {
    keep<T extends { delete(): void }>(h: T) {
      handles.push(h);
      return h;
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
test("a mapped retaining wall creates a bounded sharp break using variable terrain levels", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(cad.CrossSection.square([100, 100], true));
    const surfaceAt = (x: number, y: number) =>
      3 + 0.01 * y + (x <= -5 ? 5 : x >= 5 ? 0 : (5 - x) / 2);
    const wall = makeMappedRetainingWall(cad, owner, {
      polylineMm: [
        [0, -25],
        [0, 25],
      ],
      clip,
      resolutionMm: 5,
      foundationZ: 1,
      terrainMaxZ: 9,
      surfaceAt,
      sourceMaxHeightMm: 6,
    });
    assert.ok(wall);
    closed(wall.solid);
    closed(wall.cutter);
    assert.equal(wall.highSide, "left");
    assert.equal(wall.widthMm, 10);
    assert.ok(wall.minimumHeightMm > 4.99 && wall.maximumHeightMm < 5.01);
    assert.ok(
      wall.surfaceAt(-0.01, 0) - wall.surfaceAt(0.01, 0) > 4.9,
      "the mapped wall is vertical rather than a ramp crossing the road",
    );
    assert.equal(wall.surfaceAt(20, 0), surfaceAt(20, 0));
    assert.equal(wall.surfaceAt(0, 30), surfaceAt(0, 30));
    assert.deepEqual(wall.section.bounds(), { min: [-5, -25], max: [5, 25] });
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([100, 100, 9])).translate([-50, -50, 0]),
    );
    const corrected = owner.keep(
      owner.keep(terrain.subtract(wall.cutter)).add(wall.solid),
    );
    closed(corrected);
    const bedplate = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 0.5])).translate([-0.5, -0.5, 0]),
    );
    assert.equal(owner.keep(corrected.intersect(bedplate)).volume(), 0.5);
  } finally {
    owner.dispose();
  }
});
test("the two actual Vialleton walls retain their mapped traces and do not apply inventory maxima everywhere", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/montpellier-vialleton-approaches.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      bbox: BBox;
      scale: number;
      osmData: OverpassResponse;
      elevationGrid: ElevationGrid;
    };
    const sf = 1000 / fixture.scale,
      projection = createProjectionForBbox(fixture.bbox),
      clip = owner.keep(cad.CrossSection.square([300, 300], true));
    const surfaceAt = (x: number, y: number) => {
      const [lon, lat] = projection.unproject(x / sf, y / sf);
      return (
        3 +
        (sampleElevation(fixture.elevationGrid, lat, lon) -
          fixture.elevationGrid.minElev) *
          sf
      );
    };
    for (const [id, max] of [
      [1305300161, 6.9],
      [1305300162, 6.3],
    ]) {
      const element = fixture.osmData.elements.find((e) => e.id === id)!;
      const path = element.geometry!.map(
        (p) =>
          projection.project(p.lon, p.lat).map((v) => v * sf) as [
            number,
            number,
          ],
      );
      const wall = makeMappedRetainingWall(cad, owner, {
        polylineMm: path,
        clip,
        resolutionMm: fixture.elevationGrid.resolutionM! * sf,
        foundationZ: 2.7,
        terrainMaxZ:
          3 +
          (fixture.elevationGrid.maxElev - fixture.elevationGrid.minElev) * sf,
        surfaceAt,
        sourceMaxHeightMm: max * sf,
        sourceVerticalUncertaintyMm: 1.5 * sf,
      });
      assert.ok(wall, `mapped wall ${id} is supported by the actual terrain`);
      closed(wall.solid);
      closed(wall.cutter);
      assert.equal(wall.mode, "estimated-from-dem");
      assert.equal(wall.highSide, "left");
      assert.ok(wall.maximumHeightMm - wall.minimumHeightMm > 0.2);
      assert.ok(wall.maximumHeightMm < (max + 1.5) * sf);
      const point = path[0],
        outside: [number, number] = [point[0] + 20 * sf, point[1]];
      assert.equal(
        wall.surfaceAt(...outside),
        surfaceAt(...outside),
        "the lower street outside the wall strip keeps its datum",
      );
    }
  } finally {
    owner.dispose();
  }
});
test("a flat field or a terrain difference above the source bound cannot create a wall", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(cad.CrossSection.square([100, 100], true));
    const options = {
      polylineMm: [
        [0, -20],
        [0, 20],
      ] as [number, number][],
      clip,
      resolutionMm: 5,
      foundationZ: 1,
      terrainMaxZ: 20,
      sourceMaxHeightMm: 6,
    };
    assert.equal(
      makeMappedRetainingWall(cad, owner, { ...options, surfaceAt: () => 3 }),
      null,
    );
    assert.equal(
      makeMappedRetainingWall(cad, owner, {
        ...options,
        surfaceAt: (x) => (x < 0 ? 15 : 3),
      }),
      null,
    );
  } finally {
    owner.dispose();
  }
});

test("actual wall inserts remain attached to the complete terrain and preserve the lower street outside their bands", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/montpellier-vialleton-approaches.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      bbox: BBox;
      scale: number;
      osmData: OverpassResponse;
      fullTerrainGrid: ElevationGrid;
    };
    const grid = fixture.fullTerrainGrid,
      sf = 1000 / fixture.scale,
      projection = createProjectionForBbox(fixture.bbox);
    const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
    settings.base.topographyEnabled = true;
    const model = await buildPrintModel({
      ...fixture,
      elevationGrid: grid,
      settings,
      osmData: { elements: [] },
    });
    const width = model.dimensions.widthMm,
      depth = model.dimensions.depthMm;

    const z = new Float32Array(grid.rows * grid.cols);
    for (let row = 0; row < grid.rows; row++)
      for (let col = 0; col < grid.cols; col++) {
        const x = -width / 2 + (col / (grid.cols - 1)) * width,
          y = -depth / 2 + (row / (grid.rows - 1)) * depth;
        const [lon, lat] = projection.unproject(x / sf, y / sf);
        z[row * grid.cols + col] =
          3 + (sampleElevation(grid, lat, lon) - grid.minElev) * sf;
      }
    const originalSurfaceAt = (x: number, y: number) => {
      const u = Math.max(
          0,
          Math.min(grid.cols - 1, ((x + width / 2) / width) * (grid.cols - 1)),
        ),
        v = Math.max(
          0,
          Math.min(grid.rows - 1, ((y + depth / 2) / depth) * (grid.rows - 1)),
        );
      const col = Math.min(grid.cols - 2, Math.floor(u)),
        row = Math.min(grid.rows - 2, Math.floor(v)),
        du = u - col,
        dv = v - row,
        a = row * grid.cols + col;
      return du + dv <= 1
        ? z[a] + du * (z[a + 1] - z[a]) + dv * (z[a + grid.cols] - z[a])
        : z[a + grid.cols + 1] +
            (1 - dv) * (z[a + 1] - z[a + grid.cols + 1]) +
            (1 - du) * (z[a + grid.cols] - z[a + grid.cols + 1]);
    };
    const clip = owner.keep(cad.CrossSection.square([width, depth], true));
    for (const [id, max] of [
      [1305300161, 6.9],
      [1305300162, 6.3],
    ]) {
      const wall = makeMappedRetainingWall(cad, owner, {
        polylineMm: fixture.osmData.elements
          .find((e) => e.id === id)!
          .geometry!.map(
            (p) =>
              projection.project(p.lon, p.lat).map((v) => v * sf) as [
                number,
                number,
              ],
          ),
        clip,
        resolutionMm: grid.resolutionM! * sf,
        foundationZ: 2.7,
        terrainMaxZ: model.dimensions.heightMm,
        surfaceAt: originalSurfaceAt,
        sourceMaxHeightMm: max * sf,
        sourceVerticalUncertaintyMm: 1.5 * sf,
      });
      assert.ok(wall);
      closed(wall.solid);
      closed(wall.cutter);

      assert.equal(
        wall.surfaceAt(50.52935514535, -21.52065398514),
        originalSurfaceAt(50.52935514535, -21.52065398514),
        "the underpass datum beyond the wall strip remains unchanged",
      );
    }
    settings.base.grid = { cols: 2, rows: 2 };
    const corrected = await buildPrintModel({
      ...fixture,
      elevationGrid: grid,
      settings,
      osmData: {
        elements: fixture.osmData.elements.filter(
          (e) => e.tags?.barrier === "retaining_wall",
        ),
      },
    });
    const volume = assertClosedSolid(corrected),
      tileVolume = corrected.tiles.reduce(
        (sum, tile) => sum + assertClosedSolid(tile),
        0,
      );
    assert.equal(
      corrected.stats.components,
      1,
      "both wall inserts stay attached to the common base",
    );
    assert.equal(
      corrected.warnings.filter((w) => w.includes("Mur de soutènement")).length,
      2,
    );
    assert.ok(
      Math.abs(tileVolume - volume) / volume < 1e-4,
      "all four closed tiles preserve the terrain volume",
    );
    const terrain = owner.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: corrected.positions,
          triVerts: corrected.indices,
        }),
      ),
    );
    const bedplate = owner.keep(
      owner
        .keep(cad.Manifold.cube([width - 0.01, depth - 0.01, 2]))
        .translate([-width / 2 + 0.005, -depth / 2 + 0.005, 0]),
    );
    assert.ok(
      Math.abs(
        owner.keep(terrain.intersect(bedplate)).volume() - bedplate.volume(),
      ) < 0.01,
      "the common bedplate is intact",
    );
  } finally {
    owner.dispose();
  }
});
