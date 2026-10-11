import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold, type ManifoldToplevel } from "manifold-3d";
import { makeBasinRim } from "../src/lib/mesh/basin-rim";
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
function pyramidTerrain(
  cad: ManifoldToplevel,
  owner: ReturnType<typeof arena>,
) {
  const p = [
    0, 0, 5, -5, -5, 3, 5, -5, 3, 5, 5, 3, -5, 5, 3, -5, -5, 0, 5, -5, 0, 5, 5,
    0, -5, 5, 0,
  ];
  const t = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 7, 6, 5, 8, 7];
  for (let i = 0; i < 4; i++) {
    const a = i + 1,
      b = ((i + 1) % 4) + 1;
    t.push(a, a + 4, b, b, a + 4, b + 4);
  }
  return owner.keep(
    new cad.Manifold(
      new cad.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(p),
        triVerts: new Uint32Array(t),
      }),
    ),
  );
}

test("a printable basin rim stays outside its interior and joins the terrain", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([20, 20, 3])).translate([-10, -10, 0]),
    );
    const footprint = owner.keep(cad.CrossSection.square([6, 6], true));
    const clip = owner.keep(cad.CrossSection.square([20, 20], true));
    const rim = makeBasinRim(cad, owner, {
      footprint,
      clip,
      terrainSolid: terrain,
      terrainMaxZ: 3,
      foundationZ: 3,
      widthMm: 0,
      heightMm: 0.055,
    });
    assert.ok(rim);
    assert.equal(rim.widthMm, 0.4);
    assert.equal(rim.heightMm, 0.12);
    assert.equal(rim.adjustedDimensions, true);
    assert.equal(rim.terrainMode, "mesh");
    closed(rim.solid);
    const unified = owner.keep(terrain.add(rim.solid));
    closed(unified);
    const pieces = unified.decompose();
    assert.equal(pieces.filter((p) => p.volume() > 0).length, 1);
    pieces.forEach((p) => p.delete());
    const interior = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 0.05])).translate([-0.5, -0.5, 3.03]),
    );
    assert.equal(
      owner.keep(rim.solid.intersect(interior)).volume(),
      0,
      "water interior is not capped by the rim",
    );
    const side = owner.keep(
      owner
        .keep(cad.Manifold.cube([0.1, 0.1, 0.05]))
        .translate([3.15, 0, 3.03]),
    );
    assert.ok(owner.keep(rim.solid.intersect(side)).volume() > 0);
    assert.ok(Math.abs(rim.solid.boundingBox().max[2] - 3.12) < 1e-5);
  } finally {
    owner.dispose();
  }
});

test("the basin boundary follows exact nonplanar terrain triangles", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const terrain = pyramidTerrain(cad, owner);
    closed(terrain);
    const footprint = owner.keep(cad.CrossSection.square([2.4, 2.4], true));
    const clip = owner.keep(cad.CrossSection.square([10, 10], true));
    const rim = makeBasinRim(cad, owner, {
      footprint,
      clip,
      terrainSolid: terrain,
      terrainMaxZ: 5,
      foundationZ: 2.8,
      widthMm: 0.6,
      heightMm: 0.3,
    });
    assert.ok(rim);
    closed(rim.solid);
    closed(owner.keep(terrain.add(rim.solid)));
    const mesh = rim.solid.getMesh();
    const top = new Set<number>();
    for (let at = 0; at < mesh.vertProperties.length; at += 3) {
      const [x, y, z] = Array.from(mesh.vertProperties.subarray(at, at + 3));
      if (z > 2.8) {
        assert.ok(
          Math.abs(z - (5 - 0.4 * Math.max(Math.abs(x), Math.abs(y)) + 0.3)) <
            1e-5,
        );
        top.add(Math.round(z * 1e4));
      }
    }
    assert.ok(
      top.size > 2,
      "rim has different elevations rather than a flat slab",
    );
  } finally {
    owner.dispose();
  }
});

test("clipping a basin does not introduce a wall across its water interior", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const footprint = owner.keep(cad.CrossSection.square([6, 6], true));
    const clip = owner.keep(
      owner.keep(cad.CrossSection.square([5, 10], true)).translate([-2.5, 0]),
    );
    const rim = makeBasinRim(cad, owner, {
      footprint,
      clip,
      surfaceAt: () => 3,
      terrainMaxZ: 3,
      foundationZ: 3,
      widthMm: 0.4,
      heightMm: 0.2,
    });
    assert.ok(rim);
    closed(rim.solid);
    assert.ok(rim.solid.boundingBox().max[0] <= 1e-5);
    const interiorAtCut = owner.keep(
      owner
        .keep(cad.Manifold.cube([0.1, 1, 0.05]))
        .translate([-0.1, -0.5, 3.03]),
    );
    assert.equal(owner.keep(rim.solid.intersect(interiorAtCut)).volume(), 0);
  } finally {
    owner.dispose();
  }
});

test("islands and basin holes remain open while planar survey supports keep their slope", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const footprint = owner.keep(
      new cad.CrossSection(
        [
          [
            [-3, -3],
            [3, -3],
            [3, 3],
            [-3, 3],
          ],
          [
            [-1, -1],
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ],
        "NonZero",
      ),
    );
    const clip = owner.keep(cad.CrossSection.square([20, 20], true));
    const rim = makeBasinRim(cad, owner, {
      footprint,
      clip,
      surfaceAt: (x, y) => 8 + 0.1 * x + 0.05 * y,
      terrainMaxZ: 10,
      foundationZ: 3,
      widthMm: 0.4,
      heightMm: 0.2,
    });
    assert.ok(rim);
    assert.equal(rim.terrainMode, "plane");
    closed(rim.solid);
    const center = owner.keep(
      owner
        .keep(cad.Manifold.cube([0.5, 0.5, 0.05]))
        .translate([-0.25, -0.25, 8.03]),
    );
    assert.equal(owner.keep(rim.solid.intersect(center)).volume(), 0);
    const water = owner.keep(
      owner.keep(cad.Manifold.cube([0.1, 0.1, 0.05])).translate([2, 0, 8.23]),
    );
    assert.equal(owner.keep(rim.solid.intersect(water)).volume(), 0);
    assert.equal(
      makeBasinRim(cad, owner, {
        footprint,
        clip,
        surfaceAt: (x, y) => 3 + 0.1 * (x * x + y * y),
        terrainMaxZ: 10,
        foundationZ: 3,
        widthMm: 0.4,
        heightMm: 0.2,
      }),
      null,
      "a curved callback must supply its terrain mesh",
    );
  } finally {
    owner.dispose();
  }
});
