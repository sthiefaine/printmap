import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module, { type Mesh } from "manifold-3d";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairNumericalTriangles } from "../src/lib/mesh/repair-numerical-triangles";
import { contractShortEdges } from "../src/lib/mesh/contract-short-edges";
import { assertClosedSolid } from "./helpers/solid";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function boundary(mesh: Mesh) {
  const positions = new Float32Array(
    (mesh.vertProperties.length / mesh.numProp) * 3,
  );
  for (let i = 0; i < positions.length / 3; i++)
    positions.set(
      mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3),
      i * 3,
    );
  return {
    positions,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  };
}

test("a submicron terrain triangle contracts with its link and leaves a separate cavity unchanged", async () => {
  const cad = await runtime;
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-numerical-terrain-triangle.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const outside = cad.Manifold.cube([10, 10, 10]).translate([20, 20, 0]);
  const inside = cad.Manifold.cube([6, 6, 6]).translate([22, 22, 2]);
  const cavity = outside.subtract(inside);
  const cavityMesh = repairCoincident(cad, cavity.getMesh());
  const offset = fixture.vertProperties.length / 3;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([
      ...fixture.vertProperties,
      ...cavityMesh.vertProperties,
    ]),
    triVerts: new Uint32Array([
      ...fixture.triVerts,
      ...Array.from(cavityMesh.triVerts, (index) => index + offset),
    ]),
    runIndex: new Uint32Array([
      0,
      fixture.triVerts.length,
      fixture.triVerts.length + cavityMesh.triVerts.length,
    ]),
    runOriginalID: new Uint32Array([31, 77]),
    tolerance: 0.00001,
  });
  assert.throws(() => assertClosedSolid(boundary(input)), /positive area/);
  const original = new cad.Manifold(input);
  assert.equal(original.status(), "NoError");
  const contracted = new cad.Manifold(contractShortEdges(cad, input, 0.0001));
  assert.equal(contracted.status(), "NoError");
  assertClosedSolid(boundary(contracted.getMesh()));
  assert.ok(Math.abs(contracted.volume() - original.volume()) < 0.00001);
  const contractedParts = contracted.decompose();
  assert.equal(
    contractedParts.filter((piece) => piece.volume() < 0)[0].volume(),
    -216,
  );
  for (const part of contractedParts) part.delete();
  contracted.delete();
  const repaired = repairNumericalTriangles(cad, input);
  assert.equal(repaired.triVerts.length, input.triVerts.length - 6);
  assert.deepEqual(
    repaired.vertProperties,
    input.vertProperties,
    "all retained source coordinates stay exact",
  );
  assert.deepEqual(
    repaired.runOriginalID,
    input.runOriginalID,
    "both material runs remain present",
  );
  const solid = new cad.Manifold(repaired);
  assert.equal(solid.status(), "NoError");
  assertClosedSolid(boundary(solid.getMesh()));
  assert.ok(Math.abs(solid.volume() - original.volume()) < 0.00001);
  const pieces = solid.decompose();
  const negative = pieces.filter((piece) => piece.volume() < 0);
  assert.equal(negative.length, 1);
  assert.equal(
    negative[0].volume(),
    -216,
    "the six-millimetre cavity is not filled or shrunk",
  );
  for (const piece of pieces) piece.delete();
  for (const handle of [solid, original, cavity, inside, outside])
    handle.delete();
});

test("opposite internal sheets cancel after coordinate welding without changing the solid or palette", async () => {
  const cad = await runtime;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1,
      0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.2, 0.1,
    ]),
    triVerts: new Uint32Array([
      0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 4, 5, 6, 9, 8, 7,
    ]),
    runIndex: new Uint32Array([0, 12, 15, 18]),
    runOriginalID: new Uint32Array([31, 32, 33]),
    tolerance: 0.00001,
  });
  const originalVolume = assertClosedSolid(boundary(input));
  const repaired = repairCoincident(cad, input);
  assert.equal(repaired.triVerts.length, 12);
  assert.equal(
    repaired.vertProperties.length,
    7 * 3,
    "coincident property vertices are welded",
  );
  assert.deepEqual(Array.from(repaired.runOriginalID), [31]);
  assert.deepEqual(Array.from(repaired.runIndex), [0, 12]);
  assert.ok(
    Math.abs(assertClosedSolid(boundary(repaired)) - originalVolume) < 1e-10,
  );
  const solid = new cad.Manifold(repaired);
  assert.equal(solid.status(), "NoError");
  solid.delete();
});

test("collinear internal sheets become edge subdivisions with unchanged volume and material", async () => {
  const cad = await runtime;
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0, 9, 9, 9,
  ]);
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: positions,
    triVerts: new Uint32Array([
      0, 2, 1, 0, 4, 3, 4, 1, 3, 0, 3, 2, 1, 2, 3, 0, 1, 4,
    ]),
    runIndex: new Uint32Array([0, 3, 15, 18]),
    runOriginalID: new Uint32Array([31, 32, 33]),
    tolerance: 0.00001,
  });
  assert.throws(() => assertClosedSolid(boundary(input)), /positive area/);
  const repaired = repairCollinear(cad, input);
  assert.deepEqual(
    repaired.vertProperties,
    positions,
    "sparse original coordinates remain exact",
  );
  assert.deepEqual(Array.from(repaired.runOriginalID), [31, 32]);
  assert.deepEqual(Array.from(repaired.runIndex), [0, 6, 18]);
  assert.ok(Math.abs(assertClosedSolid(boundary(repaired)) - 1 / 6) < 1e-10);
  const solid = new cad.Manifold(repaired);
  assert.equal(solid.status(), "NoError");
  solid.delete();
});

test("chains of collinear seam triangles are repaired in either input order", async () => {
  const cad = await runtime;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.25, 0, 0, 0.75, 0, 0,
    ]),
    triVerts: new Uint32Array([
      0, 2, 1, 0, 4, 3, 4, 5, 3, 5, 1, 3, 0, 3, 2, 1, 2, 3, 4, 1, 5, 0, 1, 4,
    ]),
    runIndex: new Uint32Array([0, 24]),
    runOriginalID: new Uint32Array([15]),
    tolerance: 0.00001,
  });
  const repaired = repairCollinear(cad, input);
  assert.equal(repaired.triVerts.length, 24);
  assert.ok(Math.abs(assertClosedSolid(boundary(repaired)) - 1 / 6) < 1e-10);
});

test("unrepairable degenerate faces remain visible to strict output validation", async () => {
  const cad = await runtime;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 0, 0]),
    triVerts: new Uint32Array([0, 1, 2]),
    runIndex: new Uint32Array([0, 3]),
    runOriginalID: new Uint32Array([4]),
  });
  const repaired = repairCollinear(cad, input);
  assert.deepEqual(repaired.triVerts, input.triVerts);
  assert.throws(() => assertClosedSolid(boundary(repaired)), /positive area/);
  assert.equal(
    repairNumericalTriangles(cad, input),
    input,
    "the contraction limit never simplifies a large collinear surface",
  );
});

test("a tiny closed component is not collapsed into duplicate boundary faces", async () => {
  const cad = await runtime;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([
      0, 0, 0, 0.00003, 0, 0, 0.00003, 0, 0.000001, 0, 0.00002, 0,
    ]),
    triVerts: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    runIndex: new Uint32Array([0, 12]),
    runOriginalID: new Uint32Array([42]),
  });
  assert.equal(repairNumericalTriangles(cad, input), input);
  assert.equal(contractShortEdges(cad, input, 0.0001), input);
});

test("a short edge shared by four faces is not contracted into a different surface link", async () => {
  const cad = await runtime;
  const input = new cad.Mesh({
    numProp: 3,
    vertProperties: new Float32Array([
      0, 0, 0, 0.00005, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1,
    ]),
    triVerts: new Uint32Array([
      0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 0, 4, 1, 0, 1, 5, 0, 5, 4, 1, 4, 5,
    ]),
    runIndex: new Uint32Array([0, 12, 24]),
    runOriginalID: new Uint32Array([31, 77]),
  });
  assert.equal(contractShortEdges(cad, input, 0.0001), input);
});
