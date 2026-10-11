import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import { openEdgeContacts } from "../src/lib/mesh/open-edge-contacts";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { removeNumericalShells } from "../src/lib/mesh/retain-shells";
import { assertClosedSolid } from "./helpers/solid";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});

test("a surveyed floor contact shorter than its clearance opens the complete thin film", async () => {
  const cad = await runtime;
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-short-floor-contact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    const original = owner.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: fixture.numProp,
          vertProperties: new Float32Array(fixture.vertProperties),
          triVerts: new Uint32Array(fixture.triVerts),
          mergeFromVert: new Uint32Array(fixture.mergeFromVert),
          mergeToVert: new Uint32Array(fixture.mergeToVert),
          runIndex: new Uint32Array(fixture.runIndex),
          runOriginalID: new Uint32Array(fixture.runOriginalID),
          faceID: new Uint32Array(fixture.faceID),
        }),
      ),
    );
    const mesh = original.getMesh();
    const boundary = (value: typeof mesh) => ({
      positions: value.vertProperties,
      indices: value.triVerts,
      faceLayers: new Uint8Array(value.triVerts.length / 3),
    });
    assert.throws(() => assertClosedSolid(boundary(mesh)), /exactly two/);
    const repaired = openEdgeContacts(cad, owner, original);
    assert.equal(repaired.repairedCount, 1);
    assert.ok(
      repaired.removedVolumeMm3 > 0 &&
        repaired.removedVolumeMm3 / original.volume() < 1e-4,
    );
    const cleaned = owner.keep(
      new cad.Manifold(
        repairCollinear(cad, repairCoincident(cad, repaired.solid.getMesh())),
      ),
    );
    const final = removeNumericalShells(
      cad,
      owner,
      cleaned,
      (piece) => Math.abs(piece.volume()) > 1e-6,
    );
    assertClosedSolid(boundary(final.getMesh()));
    assert.deepEqual(
      final.boundingBox(),
      original.boundingBox(),
      "the selected print dimensions stay unchanged",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("a four-face export edge is opened by a bounded local material cut", async () => {
  const cad = await runtime;
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    // Distinct material runs retain the exterior edge's stations at Z=3 and 7.
    // The source cavity is one nanometre inside the corner; export welding at
    // 0.00001 mm makes its vertical edge coincide with that exterior edge.
    const lower = owner.keep(cad.Manifold.cube([20, 20, 3]));
    const middle = owner.keep(
      owner.keep(cad.Manifold.cube([20, 20, 4])).translate([0, 0, 3]),
    );
    const upper = owner.keep(
      owner.keep(cad.Manifold.cube([20, 20, 13])).translate([0, 0, 7]),
    );
    const body = owner.keep(cad.Manifold.union([lower, middle, upper]));
    const section = owner.keep(
      new cad.CrossSection(
        [
          [
            [0.000001, 0.000001],
            [4, 1],
            [5, 5],
            [1, 4],
          ],
        ],
        "NonZero",
      ),
    );
    const voidSolid = owner.keep(
      owner.keep(section.extrude(4)).translate([0, 0, 3]),
    );
    const original = owner.keep(body.subtract(voidSolid));
    const mesh = original.getMesh();
    const printMesh = {
      positions: mesh.vertProperties,
      indices: mesh.triVerts,
      faceLayers: new Uint8Array(mesh.triVerts.length / 3),
    };
    assert.throws(() => assertClosedSolid(printMesh), /two faces|closed|edge/);
    const repaired = openEdgeContacts(cad, owner, original);
    assert.equal(repaired.repairedCount, 1);
    assert.ok(
      repaired.removedVolumeMm3 > 0 &&
        repaired.removedVolumeMm3 / original.volume() < 1e-4,
    );
    const output = repaired.solid.getMesh();
    const palette = (value: typeof mesh) =>
      new Set(
        Array.from(value.runOriginalID).filter(
          (_, run) => value.runIndex[run + 1] > value.runIndex[run],
        ),
      );
    assert.deepEqual(
      palette(output),
      palette(mesh),
      "face source IDs and the export palette are preserved",
    );
    assertClosedSolid({
      positions: output.vertProperties,
      indices: output.triVerts,
      faceLayers: new Uint8Array(output.triVerts.length / 3),
    });
    const probe = owner.keep(
      owner.keep(cad.Manifold.cube([0.5, 0.5, 0.5])).translate([2.75, 2.75, 4]),
    );
    assert.equal(
      owner.keep(repaired.solid.intersect(probe)).volume(),
      0,
      "the existing cavity remains empty",
    );
    assert.equal(repaired.solid.boundingBox().min[2], 0);
    assert.equal(repaired.solid.boundingBox().max[2], 20);
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});

test("a closed cavity without an export contact keeps its exact solid and volume", async () => {
  const cad = await runtime;
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    const body = owner.keep(cad.Manifold.cube([10, 10, 10]));
    const voidSolid = owner.keep(
      owner.keep(cad.Manifold.cube([4, 4, 4])).translate([3, 3, 3]),
    );
    const original = owner.keep(body.subtract(voidSolid));
    const repaired = openEdgeContacts(cad, owner, original);
    assert.equal(repaired.solid, original);
    assert.equal(repaired.repairedCount, 0);
    assert.equal(repaired.removedVolumeMm3, 0);
    assert.equal(repaired.solid.volume(), 936);
    assert.throws(() => openEdgeContacts(cad, owner, original, 0.1), /0,01/);
    const output = original.getMesh();
    assertClosedSolid({
      positions: output.vertProperties,
      indices: output.triVerts,
      faceLayers: new Uint8Array(output.triVerts.length / 3),
    });
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});
