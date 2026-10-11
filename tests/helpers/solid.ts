import assert from "node:assert/strict";
import type { PrintMesh } from "../../src/types/print";

/** Independently check the exported boundary, not just the CAD kernel's status. */
export function assertClosedSolid(mesh: PrintMesh) {
  assert.ok(mesh.indices.length > 0, "solid has faces");
  assert.equal(mesh.indices.length % 3, 0);
  assert.equal(mesh.faceLayers.length, mesh.indices.length / 3);
  assert.ok(Array.from(mesh.positions).every(Number.isFinite));
  const ids = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    // Vertex properties may create seams; topology is checked at equal coordinates.
    const key = [
      mesh.positions[i],
      mesh.positions[i + 1],
      mesh.positions[i + 2],
    ]
      .map((value) => Math.round(value * 100_000))
      .join(",");
    if (!ids.has(key)) ids.set(key, ids.size);
    welded.push(ids.get(key)!);
  }
  const edges = new Map<string, { count: number; direction: number }>();
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.slice(i, i + 3));
    for (const index of [a, b, c])
      assert.ok(index < welded.length, "valid vertex index");
    assert.equal(
      new Set([welded[a], welded[b], welded[c]]).size,
      3,
      "nondegenerate triangle",
    );
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const x = welded[from],
        y = welded[to];
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      const edge = edges.get(key) ?? { count: 0, direction: 0 };
      edge.count++;
      edge.direction += x < y ? 1 : -1;
      edges.set(key, edge);
    }
    const p = mesh.positions;
    const ux = p[b * 3] - p[a * 3],
      uy = p[b * 3 + 1] - p[a * 3 + 1],
      uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3],
      vy = p[c * 3 + 1] - p[a * 3 + 1],
      vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    assert.ok(
      nx * nx + ny * ny + nz * nz > 1e-20,
      "triangle has positive area",
    );
    volume +=
      (p[a * 3] * (p[b * 3 + 1] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3 + 1]) -
        p[a * 3 + 1] * (p[b * 3] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3]) +
        p[a * 3 + 2] * (p[b * 3] * p[c * 3 + 1] - p[b * 3 + 1] * p[c * 3])) /
      6;
  }
  for (const [key, edge] of edges) {
    assert.equal(edge.count, 2, `edge ${key} has exactly two adjacent faces`);
    assert.equal(edge.direction, 0, `edge ${key} has consistent winding`);
  }
  assert.ok(volume > 0, "outward normals enclose positive volume");
  return volume;
}
