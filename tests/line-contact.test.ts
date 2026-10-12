import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module, {
  type Manifold,
  type Mesh,
  type MeshOptions,
} from "manifold-3d";
import { openEdgeContacts } from "../src/lib/mesh/open-edge-contacts";
import { repairCoincident } from "../src/lib/mesh/repair-coincident";
import { repairCollinear } from "../src/lib/mesh/repair-collinear";
import { repairNumericalTriangles } from "../src/lib/mesh/repair-numerical-triangles";
import { assertClosedSolid } from "./helpers/solid";

function boundary(mesh: Mesh) {
  return {
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  };
}

function surfaceHeight(mesh: Mesh, x: number, y: number) {
  let height = -Infinity;
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    const [a, b, c] = Array.from(mesh.triVerts.subarray(at, at + 3), (index) =>
      Array.from(mesh.vertProperties.subarray(index * 3, index * 3 + 3)),
    );
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (determinant <= 1e-10) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8)
      height = Math.max(height, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return height;
}

test("a rejected Peyrou short roof film retries one inscribed line cut without changing planes, materials or cavities", async () => {
  const cad = await Module();
  cad.setup();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-peyrou-short-roof-contact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as MeshOptions;
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  try {
    cad.Manifold.reserveIDs(Math.max(...fixture.runOriginalID!) + 1);
    const source = owner.keep(new cad.Manifold(new cad.Mesh(fixture)));
    assert.equal(source.status(), "NoError");
    const outer = owner.keep(
      owner.keep(cad.Manifold.cube([3, 3, 3])).translate([85, -52, 0]),
    );
    const inner = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 1])).translate([86, -51, 1]),
    );
    const hollow = owner.keep(owner.keep(outer.subtract(inner)).asOriginal());
    const joined = owner.keep(source.add(hollow));
    const before = joined.volume();
    const materials = new Set(joined.getMesh().runOriginalID);
    // This native short film subtraction adds material. The unchanged volume
    // guard must still reject it when the inscribed retry is not requested.
    assert.throws(
      () =>
        openEdgeContacts(cad, owner, joined, 0.005, {
          lineContactSegments: 12,
        }),
      /volume de correction autorisé/,
    );
    let result = joined;
    let removedVolume = 0;
    let closed = false;
    let contacts = 0;
    for (let pass = 0; pass < 3; pass++) {
      const repaired = openEdgeContacts(cad, owner, result, 0.005, {
        lineContactSegments: 4,
      });
      removedVolume += repaired.removedVolumeMm3;
      contacts += repaired.repairedCount;
      result = owner.keep(
        new cad.Manifold(
          repairNumericalTriangles(
            cad,
            repairCollinear(
              cad,
              repairCoincident(cad, repaired.solid.getMesh()),
            ),
          ),
        ),
      );
      assert.equal(result.status(), "NoError");
      try {
        assertClosedSolid(boundary(result.getMesh()));
        closed = true;
        break;
      } catch (error) {
        if (pass === 2) throw error;
      }
    }
    assert.ok(closed);
    assert.equal(
      contacts,
      2,
      "only the two accepted five-micron corrections are counted",
    );
    assert.ok(removedVolume > 0 && removedVolume < before * 0.0001);
    assert.ok(Math.abs(before - result.volume()) < before * 0.0001);
    assert.deepEqual(result.boundingBox(), joined.boundingBox());
    assert.deepEqual(new Set(result.getMesh().runOriginalID), materials);
    const original = joined.getMesh();
    let checkedPlanes = 0;
    for (let at = 0; at < original.triVerts.length; at += 3) {
      const [a, b, c] = Array.from(
        original.triVerts.subarray(at, at + 3),
        (index) =>
          Array.from(
            original.vertProperties.subarray(index * 3, index * 3 + 3),
          ),
      );
      const area =
        ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      if (area < 0.01) continue;
      const x = (a[0] + b[0] + c[0]) / 3,
        y = (a[1] + b[1] + c[1]) / 3;
      assert.ok(
        Math.abs(
          surfaceHeight(original, x, y) - surfaceHeight(result.getMesh(), x, y),
        ) < 0.0001,
      );
      checkedPlanes++;
    }
    assert.ok(
      checkedPlanes > 5,
      "several visible source planes retain their height",
    );
    const shells = result.decompose();
    try {
      assert.equal(
        shells.filter((shell) => shell.volume() > 0.000001).length,
        1,
      );
      const voids = shells.filter((shell) => shell.volume() < -0.000001);
      assert.equal(voids.length, 1);
      assert.ok(Math.abs(voids[0].volume() + 1) < 1e-10);
      assert.deepEqual(voids[0].boundingBox(), inner.boundingBox());
    } finally {
      for (const shell of shells) shell.delete();
    }
    assert.equal(owner.keep(result.intersect(inner)).volume(), 0);
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("a captured Comédie LiDAR roof contact closes with an inscribed four-sided cut and preserves cavity and materials", async () => {
  const cad = await Module();
  cad.setup();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/montpellier-comedie-lidar-roof-contact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as MeshOptions;
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  const clean = (solid: Manifold) =>
    owner.keep(
      new cad.Manifold(
        repairNumericalTriangles(
          cad,
          repairCollinear(cad, repairCoincident(cad, solid.getMesh())),
        ),
      ),
    );
  try {
    cad.Manifold.reserveIDs(Math.max(...fixture.runOriginalID!) + 1);
    const source = owner.keep(new cad.Manifold(new cad.Mesh(fixture)));
    assert.equal(source.status(), "NoError");
    // The native boundary is closed, but two roof junctions have four faces
    // after Float32 welding. The previous 12-sided cut leaves a tiny triangle.
    const legacy = openEdgeContacts(cad, owner, source, 0.005, {
      coplanarFootprint: "faces",
      lineContactSegments: 12,
    });
    assert.equal(legacy.repairedCount, 2);
    assert.throws(
      () => assertClosedSolid(boundary(clean(legacy.solid).getMesh())),
      /triangle has positive area/,
    );

    // Add a connected hollow volume away from the captured contact. The repair
    // must keep the negative boundary, its original material, and the empty void.
    const outer = owner.keep(
      owner.keep(cad.Manifold.cube([3, 3, 3])).translate([-91, -2, 0]),
    );
    const inner = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 1])).translate([-90, -1, 1]),
    );
    const hollow = owner.keep(owner.keep(outer.subtract(inner)).asOriginal());
    const joined = owner.keep(source.add(hollow));
    const before = joined.volume();
    const materials = new Set(joined.getMesh().runOriginalID);
    const repaired = openEdgeContacts(cad, owner, joined, 0.005, {
      coplanarFootprint: "faces",
      lineContactSegments: 4,
    });
    assert.equal(repaired.repairedCount, 2);
    assert.ok(repaired.removedVolumeMm3 > 0);
    assert.ok(repaired.removedVolumeMm3 / before < 0.0001);
    const result = clean(repaired.solid);
    const after = result.getMesh();
    assert.equal(result.status(), "NoError");
    assert.ok(
      Math.abs(assertClosedSolid(boundary(after)) - result.volume()) < 1e-9,
    );
    assert.ok(
      Math.abs(before - result.volume() - repaired.removedVolumeMm3) <
        before * 1e-8,
    );
    assert.deepEqual(new Set(after.runOriginalID), materials);
    assert.deepEqual(result.boundingBox(), joined.boundingBox());
    const shells = result.decompose();
    try {
      assert.equal(shells.filter((shell) => shell.volume() > 0).length, 1);
      const voids = shells.filter((shell) => shell.volume() < 0);
      assert.equal(voids.length, 1);
      assert.ok(Math.abs(voids[0].volume() + 1) < 1e-12);
      assert.deepEqual(voids[0].boundingBox(), inner.boundingBox());
    } finally {
      for (const shell of shells) shell.delete();
    }
    assert.equal(owner.keep(result.intersect(inner)).volume(), 0);
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});
