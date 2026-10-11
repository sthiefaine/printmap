import assert from "node:assert/strict";
import test from "node:test";
import Module from "manifold-3d";
import { removeNumericalShells } from "../src/lib/mesh/retain-shells";
import { assertClosedSolid } from "./helpers/solid";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});

test("removing a numerical shell preserves a closed internal cavity and its source palette", async () => {
  const cad = await runtime;
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    const outer = owner.keep(
      owner.keep(cad.Manifold.cube([10, 10, 10])).asOriginal(),
    );
    const inner = owner.keep(
      owner
        .keep(owner.keep(cad.Manifold.cube([4, 4, 4])).translate([3, 3, 3]))
        .asOriginal(),
    );
    const cavity = owner.keep(outer.subtract(inner));
    const micro = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 0.0001])).translate([15, 0, 0]),
    );
    const input = owner.keep(cavity.add(micro));
    const expectedPalette = new Set(cavity.getMesh().runOriginalID);
    const cleaned = removeNumericalShells(
      cad,
      owner,
      input,
      (component) => Math.abs(component.volume()) > 0.001,
    );
    assert.equal(cleaned.status(), "NoError");
    assert.ok(Math.abs(cleaned.volume() - 936) < 1e-5);
    const probe = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 1])).translate([4, 4, 4]),
    );
    assert.equal(
      owner.keep(cleaned.intersect(probe)).volume(),
      0,
      "the cavity remains empty",
    );
    const mesh = cleaned.getMesh();
    assert.deepEqual(new Set(mesh.runOriginalID), expectedPalette);
    assert.ok(
      Math.abs(
        assertClosedSolid({
          positions: mesh.vertProperties,
          indices: mesh.triVerts,
          faceLayers: new Uint8Array(mesh.triVerts.length / 3),
        }) - 936,
      ) < 1e-5,
    );
    const retained = cleaned.decompose();
    assert.deepEqual(
      retained
        .map((component) => Math.round(component.volume()))
        .sort((a, b) => a - b),
      [-64, 1000],
    );
    for (const component of retained) component.delete();
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});

test("retaining every shell returns the exact original solid without a CSG operation", async () => {
  const cad = await runtime;
  const outer = cad.Manifold.cube([10, 10, 10]);
  const sourceInner = cad.Manifold.cube([4, 4, 4]);
  const inner = sourceInner.translate([3, 3, 3]);
  const solid = outer.subtract(inner);
  try {
    const owner = {
      keep<T extends { delete(): void }>(handle: T): T {
        throw new Error(`Unexpected allocation: ${handle}`);
      },
    };
    assert.equal(
      removeNumericalShells(cad, owner, solid, () => true),
      solid,
    );
    assert.equal(solid.volume(), 936);
  } finally {
    solid.delete();
    inner.delete();
    sourceInner.delete();
    outer.delete();
  }
});
