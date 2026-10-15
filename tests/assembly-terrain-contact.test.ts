import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { type Manifold, type Mesh } from "manifold-3d";
import { openEdgeContacts } from "../src/lib/mesh/open-edge-contacts";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairNumericalTriangles } from "../src/lib/mesh/repair-numerical-triangles";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/montpellier-assembly-terrain-contact.json", import.meta.url), "utf8"));
function usedMaterials(mesh: Mesh) {
  // Native clipping retains zero-length ancestry runs. They own no faces and
  // do not describe visible materials in the cropped source.
  return new Set(Array.from(mesh.runOriginalID).filter((_, index) => mesh.runIndex[index + 1] > mesh.runIndex[index]));
}
function boundary(mesh: Mesh) {
  return {
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  };
}

test("a real assembly terrain/foundation contact closes with an inscribed line retry, retaining its cavity and materials", async () => {
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const arena = {
    keep<T extends { delete(): void }>(handle: T): T { handles.push(handle); return handle; },
  };
  try {
    const mesh = new cad.Mesh({
      ...fixture.mesh,
      vertProperties: new Float32Array(fixture.mesh.vertProperties),
      triVerts: new Uint32Array(fixture.mesh.triVerts),
      mergeFromVert: new Uint32Array(fixture.mesh.mergeFromVert),
      mergeToVert: new Uint32Array(fixture.mesh.mergeToVert),
      runIndex: new Uint32Array(fixture.mesh.runIndex),
      runOriginalID: new Uint32Array(fixture.mesh.runOriginalID),
      runTransform: new Float64Array(fixture.mesh.runTransform),
      faceID: new Uint32Array(fixture.mesh.faceID),
    });
    assert.throws(() => assertClosedSolid(boundary(mesh)), /exactly two adjacent faces/);
    const source = arena.keep(new cad.Manifold(mesh));
    const cavity = arena.keep(cad.Manifold.cube([0.5, 0.5, 0.5]).translate([41.5, -56, 1]));
    const parent = arena.keep(source.subtract(cavity));
    const originalVolume = parent.volume();
    const originalMaterials = usedMaterials(parent.getMesh());
    const originalVoids = parent.decompose()
      .map((part: Manifold) => arena.keep(part))
      .filter((part: Manifold) => part.volume() < 0)
      .map((part: Manifold) => ({ volume: part.volume(), bounds: part.boundingBox() }))
      .sort((a, b) => a.volume - b.volume);
    assert.ok(originalVoids.some((part) => Math.abs(part.volume + 0.125) < 1e-8), "the control cavity starts empty");
    const materials = new Map<number, string>(fixture.materials);
    const repaired = openEdgeContacts(cad, arena, parent, 0.005, {
      lineContactSegments: 4,
      shortContactShape: "line",
      coplanarFootprint: (id) => ["basePlate", "roads"].includes(materials.get(id) ?? "basePlate") ? "bounds" : "faces",
    });
    assert.ok(repaired.repairedCount > 0, "the captured precision contact is actually repaired");
    const closed = arena.keep(new cad.Manifold(
      repairCollinear(cad, repairNumericalTriangles(cad, repairCoincident(cad, repaired.solid.getMesh()))),
    ));
    assertClosedSolid(boundary(closed.getMesh()));
    assert.ok(repaired.removedVolumeMm3 > 0 && repaired.removedVolumeMm3 < 0.00001);
    assert.ok(Math.abs(closed.volume() - originalVolume) < 0.00001, "only the sub-print-resolution contact changes");
    assert.deepEqual(usedMaterials(closed.getMesh()), originalMaterials);
    const parts = closed.decompose().map((part: Manifold) => arena.keep(part));
    const voids = parts.filter((part: Manifold) => part.volume() < 0)
      .map((part: Manifold) => ({ volume: part.volume(), bounds: part.boundingBox() }))
      .sort((a, b) => a.volume - b.volume);
    assert.equal(voids.length, originalVoids.length, "both the authentic source cavity and the control cavity remain empty");
    for (let index = 0; index < originalVoids.length; index++) {
      assert.ok(Math.abs(voids[index].volume - originalVoids[index].volume) < 1e-8, "negative cavity winding and volume are retained");
      assert.deepEqual(voids[index].bounds, originalVoids[index].bounds);
    }
    assert.deepEqual(closed.boundingBox(), parent.boundingBox());
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});
