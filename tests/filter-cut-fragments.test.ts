import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold, type ManifoldToplevel } from "manifold-3d";
import { filterCutFragments } from "../src/lib/mesh/filter-cut-fragments";
import { assertClosedSolid } from "./helpers/solid";

async function control(
  run: (
    cad: ManifoldToplevel,
    keep: <T extends { delete(): void }>(value: T) => T,
  ) => void,
) {
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(value: T): T => {
    handles.push(value);
    return value;
  };
  try {
    run(cad, keep);
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
}

const options = {
  minimumFeatureMm: 0.8,
  min: [3, 0] as [number, number],
  max: [8, 8] as [number, number],
  internalEdges: { west: true, east: false, south: false, north: false },
  hasMaterial: (part: Manifold) => Math.abs(part.volume()) > 0.000001,
};

test("a real balcony cut keeps its parent and declares only the separated sub-resolution tip", async () =>
  control((cad, keep) => {
    const base = keep(cad.Manifold.cube([8, 8, 1]));
    const tower = keep(keep(cad.Manifold.cube([1, 1, 6])).translate([1, 3, 1]));
    const balcony = keep(
      keep(cad.Manifold.cube([3, 0.4, 0.2])).translate([1, 3, 5]),
    );
    const parent = keep(cad.Manifold.union([base, tower, balcony]));
    const tile = keep(keep(cad.Manifold.cube([5, 8, 8])).translate([3, 0, 0]));
    const cut = keep(parent.intersect(tile));
    const filtered = filterCutFragments(cad, { keep }, cut, options);
    assert.equal(filtered.discardedCount, 1);
    assert.ok(Math.abs(filtered.discardedVolumeMm3 - 0.08) < 1e-8);
    assert.ok(
      Math.abs(
        filtered.solid.volume() + filtered.discardedVolumeMm3 - cut.volume(),
      ) < 1e-8,
    );
    const mesh = filtered.solid.getMesh();
    assert.ok(
      Math.abs(
        assertClosedSolid({
          positions: mesh.vertProperties,
          indices: mesh.triVerts,
          faceLayers: new Uint8Array(mesh.triVerts.length / 3),
        }) - 40,
      ) < 1e-8,
    );
    assert.ok(
      parent.volume() > filtered.solid.volume(),
      "the original whole model still owns the balcony",
    );
  }));

test("a larger detached cantilever and material away from a cut edge are never silently filtered", async () =>
  control((cad, keep) => {
    const base = keep(keep(cad.Manifold.cube([5, 8, 1])).translate([3, 0, 0]));
    const large = keep(keep(cad.Manifold.cube([1, 1, 1])).translate([3, 1, 5]));
    const inside = keep(
      keep(cad.Manifold.cube([0.2, 0.2, 0.2])).translate([4, 3, 5]),
    );
    const cut = keep(cad.Manifold.union([base, large, inside]));
    const filtered = filterCutFragments(cad, { keep }, cut, options);
    assert.equal(filtered.discardedCount, 0);
    assert.equal(filtered.solid, cut);
  }));

test("a tiny hollow cut fragment keeps its outer boundary and its negative cavity together", async () =>
  control((cad, keep) => {
    const base = keep(keep(cad.Manifold.cube([5, 8, 1])).translate([3, 0, 0]));
    const outer = keep(
      keep(cad.Manifold.cube([0.4, 0.4, 0.4])).translate([3, 2, 5]),
    );
    const inner = keep(
      keep(cad.Manifold.cube([0.2, 0.2, 0.2])).translate([3.1, 2.1, 5.1]),
    );
    const hollow = keep(outer.subtract(inner));
    const cut = keep(cad.Manifold.union([base, hollow]));
    const before = cut.volume();
    const filtered = filterCutFragments(cad, { keep }, cut, options);
    assert.equal(filtered.discardedCount, 0);
    assert.equal(filtered.solid.volume(), before);
    const parts = filtered.solid.decompose().map(keep);
    assert.ok(
      parts.some((part) => Math.abs(part.volume() + 0.008) < 1e-8),
      "the internal cavity remains empty with its original winding",
    );
  }));

test("grounded small material and exterior edges do not qualify as cut tips", async () =>
  control((cad, keep) => {
    const ground = keep(
      keep(cad.Manifold.cube([0.2, 0.2, 0.2])).translate([3, 2, 0]),
    );
    const filtered = filterCutFragments(cad, { keep }, ground, options);
    assert.equal(filtered.discardedCount, 0);
    const floating = keep(ground.translate([0, 0, 5]));
    const outside = filterCutFragments(cad, { keep }, floating, {
      ...options,
      internalEdges: { ...options.internalEdges, west: false },
    });
    assert.equal(outside.discardedCount, 0);
  }));
