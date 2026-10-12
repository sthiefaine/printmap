import assert from "node:assert/strict";
import test from "node:test";
import Module, { type ManifoldToplevel, type Mesh } from "manifold-3d";
import { removeCoincidentSheets } from "../src/lib/mesh/repair-coincident";
import { assertClosedSolid } from "./helpers/solid";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});

function boundary(mesh: Mesh) {
  assert.equal(mesh.numProp, 3);
  return {
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  };
}

function materialIds(mesh: Mesh) {
  return new Set(
    Array.from(mesh.runOriginalID).filter(
      (_, run) => mesh.runIndex[run + 1] > mesh.runIndex[run],
    ),
  );
}

function neighbouringCubes(cad: ManifoldToplevel, rotateSecond: boolean) {
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  const first = owner.keep(
    owner.keep(cad.Manifold.cube([3, 3, 3])).translate([40, 0, 0]),
  );
  let second = owner.keep(cad.Manifold.cube([3, 3, 3]));
  if (rotateSecond) second = owner.keep(second.rotate([90, 0, 0]));
  // A quarter turn changes the native face diagonal, not the cube's footprint.
  // The gap is 1e-7 mm = 0.1 nm; Float32 export at X=43 rounds it away.
  second = owner.keep(second.translate([43.0000001, rotateSecond ? 3 : 0, 0]));
  const cavity = owner.keep(
    owner.keep(cad.Manifold.cube([1, 1, 1])).translate([41, 1, 1]),
  );
  const original = owner.keep(
    owner.keep(cad.Manifold.union([first, second])).subtract(cavity),
  );
  return {
    owner,
    original,
    second,
    allocationCount: () => handles.length,
    dispose: () => {
      for (const handle of handles.reverse()) handle.delete();
    },
  };
}

test("native Float32 opposite sheets cancel without losing the cavity, dimensions or material IDs", async () => {
  const cad = await runtime;
  const pair = neighbouringCubes(cad, true);
  try {
    assert.deepEqual(pair.second.boundingBox(), {
      min: [43.0000001, 0, 0],
      max: [46.0000001, 3, 3],
    });
    assert.equal(pair.original.status(), "NoError");
    assert.ok(Math.abs(pair.original.volume() - 53) < 1e-9);
    const source = pair.original.getMesh();
    assert.throws(() => assertClosedSolid(boundary(source)), /exactly two/);
    assert.equal(materialIds(source).size, 3);

    const repaired = removeCoincidentSheets(cad, pair.owner, pair.original);
    assert.notEqual(repaired, pair.original);
    assert.equal(repaired.status(), "NoError");
    const output = repaired.getMesh();
    assert.equal(
      output.triVerts.length,
      source.triVerts.length - 12,
      "the two opposed triangles on each side of the shared face cancel",
    );
    assert.ok(Math.abs(assertClosedSolid(boundary(output)) - 53) < 1e-9);
    assert.ok(Math.abs(repaired.volume() - pair.original.volume()) < 1e-9);
    assert.deepEqual(materialIds(output), materialIds(source));
    assert.deepEqual(repaired.boundingBox(), {
      min: [40, 0, 0],
      max: [46, 3, 3],
    });
    const before = pair.original.boundingBox();
    const after = repaired.boundingBox();
    for (const side of ["min", "max"] as const)
      for (let axis = 0; axis < 3; axis++)
        assert.ok(
          Math.abs(before[side][axis] - after[side][axis]) < 1e-6,
          "only sub-Float32 differences in the native bounds are discarded",
        );

    const shells = repaired.decompose().map((shell) => pair.owner.keep(shell));
    const negative = shells.filter((shell) => shell.volume() < 0);
    assert.equal(shells.filter((shell) => shell.volume() > 0).length, 1);
    assert.equal(negative.length, 1);
    assert.ok(Math.abs(negative[0].volume() + 1) < 1e-9);
    assert.deepEqual(negative[0].boundingBox(), {
      min: [41, 1, 1],
      max: [42, 2, 2],
    });

    const allocations = pair.allocationCount();
    assert.equal(removeCoincidentSheets(cad, pair.owner, repaired), repaired);
    assert.equal(
      pair.allocationCount(),
      allocations,
      "a clean solid keeps its native geometry without a new allocation",
    );
  } finally {
    pair.dispose();
  }
});

test("different native face diagonals keep their identity for later contact processing", async () => {
  const cad = await runtime;
  const pair = neighbouringCubes(cad, false);
  try {
    assert.equal(pair.original.status(), "NoError");
    assert.ok(Math.abs(pair.original.volume() - 53) < 1e-9);
    const source = pair.original.getMesh();
    assert.throws(() => assertClosedSolid(boundary(source)), /exactly two/);
    const allocations = pair.allocationCount();
    const result = removeCoincidentSheets(cad, pair.owner, pair.original);
    assert.equal(result, pair.original);
    assert.equal(pair.allocationCount(), allocations);
    assert.deepEqual(result.getMesh().triVerts, source.triVerts);
    assert.deepEqual(materialIds(result.getMesh()), materialIds(source));
    // No matching triangle pair was removed. This helper does not claim to
    // close every coincident polygon; the pipeline must handle this contact.
    assert.throws(
      () => assertClosedSolid(boundary(result.getMesh())),
      /exactly two/,
    );
  } finally {
    pair.dispose();
  }
});
