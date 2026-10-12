import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module, { type Mesh } from "manifold-3d";
import { openEdgeContacts } from "../src/lib/mesh/open-edge-contacts";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { repairNumericalTriangles } from "../src/lib/mesh/repair-numerical-triangles";
import { removeNumericalShells } from "../src/lib/mesh/retain-shells";
import { assertClosedSolid } from "./helpers/solid";

test("a captured LiDAR terrace film opens within its face bounds without carrying the contact to neighbouring terrain", async () => {
  const cad = await Module();
  cad.setup();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-peyrou-lidar-coplanar-contact.json",
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
  const boundary = (mesh: Mesh) => ({
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  });
  const palette = (mesh: Mesh) =>
    new Set(
      Array.from(mesh.runOriginalID).filter(
        (_, run) => mesh.runIndex[run + 1] > mesh.runIndex[run],
      ),
    );
  try {
    const crop = owner.keep(
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
          tolerance: fixture.tolerance,
        }),
      ),
    );
    // This independent synthetic void is a control, not a source feature. It
    // must remain empty and retain negative winding throughout terrain repair.
    const voidSolid = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 1])).translate([-35, -15, 1]),
    );
    const original = owner.keep(crop.subtract(voidSolid));
    assert.equal(original.status(), "NoError");
    assert.throws(() => assertClosedSolid(boundary(original.getMesh())));
    const oldRepair = openEdgeContacts(cad, owner, original);
    assert.equal(oldRepair.repairedCount, 1);
    const oldCleaned = owner.keep(
      new cad.Manifold(
        repairNumericalTriangles(
          cad,
          repairCollinear(
            cad,
            repairCoincident(cad, oldRepair.solid.getMesh()),
          ),
        ),
      ),
    );
    assert.throws(
      () => assertClosedSolid(boundary(oldCleaned.getMesh())),
      /exactly two/,
      "a rounded cut through only one face pair moves this real contact",
    );

    let result = original;
    let removed = 0;
    let passed = false;
    let passages = 0;
    const materialIds = palette(original.getMesh());
    const selectedIds = new Set<number>();
    for (; passages < 3; passages++) {
      const repair = openEdgeContacts(cad, owner, result, 0.005, {
        coplanarFootprint: (originalId) => {
          selectedIds.add(originalId);
          return materialIds.has(originalId) ? "bounds" : "faces";
        },
        lineContactSegments: 4,
      });
      removed += repair.removedVolumeMm3;
      const cleaned = owner.keep(
        new cad.Manifold(
          repairNumericalTriangles(
            cad,
            repairCollinear(cad, repairCoincident(cad, repair.solid.getMesh())),
          ),
        ),
      );
      result = removeNumericalShells(
        cad,
        owner,
        cleaned,
        (piece) => Math.abs(piece.volume()) > 1e-6,
      );
      try {
        assertClosedSolid(boundary(result.getMesh()));
        passed = true;
        break;
      } catch {
        // The regular pipeline has the same strict validator and three-pass
        // limit. A failed final boundary remains a failed test below.
      }
    }
    assert.ok(passed);
    assert.ok(selectedIds.size > 0);
    assert.ok([...selectedIds].every((id) => materialIds.has(id)));
    assert.ok(
      passages <= 1,
      "the real contact closes within two bounded passages",
    );
    assert.ok(removed > 0 && removed / original.volume() < 1e-4);
    assert.ok(
      Math.abs(original.volume() - result.volume() - removed) <
        original.volume() * 1e-8,
    );
    assert.deepEqual(result.boundingBox(), original.boundingBox());
    assert.deepEqual(palette(result.getMesh()), palette(original.getMesh()));
    assert.equal(owner.keep(result.intersect(voidSolid)).volume(), 0);
    const pieces = result.decompose();
    const cavities = pieces.filter((piece) => piece.volume() < 0);
    assert.equal(cavities.length, 1);
    assert.ok(Math.abs(cavities[0].volume() + 1) < 1e-10);
    assert.deepEqual(cavities[0].boundingBox(), voidSolid.boundingBox());
    for (const piece of pieces) piece.delete();
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});
