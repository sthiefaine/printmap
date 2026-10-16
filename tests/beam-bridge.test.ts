import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { makeBeamBridge } from "../src/lib/mesh/beam-bridge";
import { verifiedBridgeDeckProfile } from "../src/lib/data/bridge-deck-profile";
import { createProjectionForBbox } from "../src/lib/projection";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/montpellier-lez-bridges.json", import.meta.url),
    "utf8",
  ),
) as PrintInput;

/** Independent vertical intersections of the exported triangles. */
function crossings(mesh: PrintMesh, x: number, y: number, layer?: string) {
  const hits: number[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    if (layer && PRINT_LAYERS[mesh.faceLayers[i / 3]] !== layer) continue;
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (id) =>
      Array.from(mesh.positions.subarray(id * 3, id * 3 + 3)),
    );
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-10) continue;
    const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / d;
    const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / d;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      hits.push(a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return [...new Set(hits.map((z) => Number(z.toFixed(5))))].sort(
    (a, b) => a - b,
  );
}

test("real Lez decks use the upper IGN surface, preserve the river below and close all four plates", async () => {
  for (const assemblyFrame of [
    undefined,
    { originLat: 43.6074, elevationDatumM: 0 },
  ]) {
    const input = { ...structuredClone(fixture), assemblyFrame };
    const model = await buildPrintModel(input);
    const volume = assertClosedSolid(model);
    const tileVolume = model.tiles.reduce(
      (sum, tile) => sum + assertClosedSolid(tile),
      0,
    );
    assert.ok(Math.abs(tileVolume - volume) / volume < 1e-4);
    assert.equal(model.stats.reconstructedBridgeCount, 2);
    assert.equal(
      model.stats.pierCount,
      0,
      "bridge decks are not embossed brown quays",
    );
    assert.deepEqual(
      model.landmarks?.map((item) => [item.id, item.name, item.representation]),
      [
        ["way/661170739", "Pont Juvénal", "reconstructed-bridge"],
        ["way/661170808", "Passerelle Aphrodite", "reconstructed-bridge"],
      ],
    );
    assert.ok(
      model.landmarks!.every((item) =>
        item.min.every((value, axis) => value < item.max[axis]),
      ),
    );
    const projection = createProjectionForBbox(
      fixture.bbox,
      assemblyFrame?.originLat,
    );
    const datum =
      assemblyFrame?.elevationDatumM ?? fixture.elevationGrid!.minElev;
    const sf = 1000 / fixture.scale;
    const profile = verifiedBridgeDeckProfile(
      "way/661170739",
      fixture.osmData.elements,
    )!;
    for (const index of [8, 15, 22]) {
      const sample = profile.points[index];
      const [x, y] = projection
        .project(sample.lon, sample.lat)
        .map((v) => v * sf);
      const z = 3 + (sample.elevationM - datum) * sf;
      const levels = crossings(model, x, y);
      assert.equal(
        levels.length,
        4,
        `river, underside and deck are separate at sample ${index}: ${levels}`,
      );
      assert.ok(
        Math.abs(levels.at(-1)! - z) < 0.002,
        "the upper surface follows the actual MNS profile, including its camber",
      );
      assert.ok(
        levels[2] - levels[1] > 0.8,
        "the exported beam leaves an actual open river passage",
      );
      assert.ok(
        crossings(model, x, y, "roads").some((h) => Math.abs(h - z) < 0.002),
        "the carried road is on the upper deck",
      );
      const tile = model.tiles.find((t) => {
        const cx = -model.dimensions.widthMm / 2 + (t.col + 0.5) * t.widthMm;
        const cy = -model.dimensions.depthMm / 2 + (t.row + 0.5) * t.depthMm;
        return (
          Math.abs(x - cx) < t.widthMm / 2 && Math.abs(y - cy) < t.depthMm / 2
        );
      })!;
      const tx =
        x - (-model.dimensions.widthMm / 2 + (tile.col + 0.5) * tile.widthMm);
      const ty =
        y - (-model.dimensions.depthMm / 2 + (tile.row + 0.5) * tile.depthMm);
      assert.ok(
        crossings(tile, tx, ty, "roads").some((h) => Math.abs(h - z) < 0.002),
        "the actual cut plate retains the same deck datum",
      );
      assert.equal(
        crossings(model, x, y, "piers").length,
        0,
        "no brown footprint masks the river or road",
      );
      assert.ok(
        crossings(model, x, y, "water").some(
          (h) => Math.abs(h - levels[1]) < 0.002,
        ),
        "water remains under the bridge",
      );
    }
    // The old translated skin alternated buildings/roads at the 31 profile
    // joints. Every midpoint lies inside the same continuous mapped carriageway.
    for (let index = 0; index < profile.points.length - 1; index++) {
      const a = profile.points[index],
        b = profile.points[index + 1];
      const [x, y] = projection
        .project((a.lon + b.lon) / 2, (a.lat + b.lat) / 2)
        .map((value) => value * sf);
      const z = 3 + ((a.elevationM + b.elevationM) / 2 - datum) * sf;
      assert.ok(
        crossings(model, x, y, "roads").some(
          (height) => Math.abs(height - z) < 0.002,
        ),
        `carriageway remains road at profile interval ${index}; no transverse material bands`,
      );
      const tile = model.tiles.find(
        (t) =>
          Math.abs(
            x - (-model.dimensions.widthMm / 2 + (t.col + 0.5) * t.widthMm),
          ) <
            t.widthMm / 2 &&
          Math.abs(
            y - (-model.dimensions.depthMm / 2 + (t.row + 0.5) * t.depthMm),
          ) <
            t.depthMm / 2,
      )!;
      const tx =
        x - (-model.dimensions.widthMm / 2 + (tile.col + 0.5) * tile.widthMm);
      const ty =
        y - (-model.dimensions.depthMm / 2 + (tile.row + 0.5) * tile.depthMm);
      assert.ok(
        crossings(tile, tx, ty, "roads").some(
          (height) => Math.abs(height - z) < 0.002,
        ),
        `cut plate retains continuous road colour at profile interval ${index}`,
      );
    }
    // Aphrodite is really close to water: it must not be arbitrarily raised to
    // create a photogenic opening that does not exist at this scale.
    const aphrodite = verifiedBridgeDeckProfile(
      "way/661170808",
      fixture.osmData.elements,
    )!;
    const p = aphrodite.points[5];
    const [x, y] = projection.project(p.lon, p.lat).map((v) => v * sf);
    assert.ok(
      Math.abs(
        crossings(model, x, y).at(-1)! - (3 + (p.elevationM - datum) * sf),
      ) < 0.002,
    );
    assert.ok(
      model.warnings.some((w) =>
        /sous-face et épaisseur.*non relevées/.test(w),
      ),
    );
    assert.ok(model.warnings.some((w) => /passerelles très basses/.test(w)));
    assert.ok(model.sources.some((s) => /LiDAR HD.*MNS/.test(s)));
  }
});

test("verified deck samples require both stable identity and the actual mapped location", () => {
  assert.equal(
    verifiedBridgeDeckProfile("way/1", fixture.osmData.elements),
    null,
  );
  const moved = structuredClone(fixture.osmData.elements);
  for (const p of moved.find((e) => e.id === 661170739)!.geometry!)
    p.lon += 0.01;
  assert.equal(verifiedBridgeDeckProfile("way/661170739", moved), null);
});

test("generic beam keeps mapped deck holes and refuses a detached deck without inventing a pier", async () => {
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const arena = {
    keep<T extends { delete(): void }>(h: T) {
      handles.push(h);
      return h;
    },
  };
  try {
    const footprint = arena.keep(
      new cad.CrossSection(
        [
          [
            [-10, -3],
            [10, -3],
            [10, 3],
            [-10, 3],
          ],
          [
            [-1, -1],
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ],
        "EvenOdd",
      ),
    );
    const clip = arena.keep(cad.CrossSection.square([30, 20], true));
    const terrain = arena.keep(
      arena.keep(cad.Manifold.cube([30, 20, 3], true)).translate([0, 0, 1.5]),
    );
    const banks = arena.keep(
      cad.Manifold.union([
        arena.keep(
          arena
            .keep(cad.Manifold.cube([3, 8, 2], true))
            .translate([-9.5, 0, 3]),
        ),
        arena.keep(
          arena.keep(cad.Manifold.cube([3, 8, 2], true)).translate([9.5, 0, 3]),
        ),
      ]),
    );
    const actualTerrain = arena.keep(terrain.add(banks));
    const beam = makeBeamBridge(cad, arena, {
      footprint,
      clip,
      profile: [
        { point: [-10, 0], z: 4 },
        { point: [0, 0], z: 4.2 },
        { point: [10, 0], z: 4 },
      ],
      thicknessMm: 0.25,
      terrainSolid: actualTerrain,
      terrainMaxZ: 4,
    });
    assert.ok(beam);
    const hole = arena.keep(
      arena.keep(cad.Manifold.cube([1, 1, 8], true)).translate([0, 0, 4]),
    );
    assert.ok(
      arena.keep(beam.solid.intersect(hole)).isEmpty(),
      "a mapped aperture is not filled by the deck construction",
    );
    const union = arena.keep(actualTerrain.add(beam.solid));
    assert.equal(union.decompose().map((h) => arena.keep(h)).length, 1);
    assert.equal(
      makeBeamBridge(cad, arena, {
        footprint,
        clip,
        profile: [
          { point: [-10, 0], z: 8 },
          { point: [10, 0], z: 8 },
        ],
        thicknessMm: 0.25,
        terrainSolid: actualTerrain,
        terrainMaxZ: 4,
      }),
      null,
    );
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});
