import type { ManifoldToplevel, Mesh, MeshOptions } from "manifold-3d";

/** Cancel coincident opposite internal sheets after the kernel's simplification. */
export function repairCoincident(cad: ManifoldToplevel, mesh: Mesh): Mesh {
  const ids = new Map<string, number>();
  const vertices = new Uint32Array(mesh.vertProperties.length / mesh.numProp);
  const positions: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const at = i * mesh.numProp;
    const point = Array.from(mesh.vertProperties.subarray(at, at + 3));
    const key = point.map((value) => Math.round(value * 100000)).join(",");
    let id = ids.get(key);
    if (id == null) {
      id = ids.size;
      ids.set(key, id);
      positions.push(...point);
    }
    vertices[i] = id;
  }
  const indices = Array.from(mesh.triVerts, (index) => vertices[index]);
  const cancelled = new Set<number>();
  const faces = new Map<string, { face: number; sign: number }[]>();
  for (let at = 0; at < indices.length; at += 3) {
    const [a, b, c] = indices.slice(at, at + 3);
    if (a === b || b === c || c === a) {
      cancelled.add(at);
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(":");
    const sign = (a < b ? 1 : -1) * (b < c ? 1 : -1) * (c < a ? 1 : -1);
    const pending = faces.get(key) ?? [];
    const opposite = pending.findIndex((face) => face.sign !== sign);
    if (opposite >= 0) {
      cancelled.add(at);
      cancelled.add(pending[opposite].face);
      pending.splice(opposite, 1);
    } else pending.push({ face: at, sign });
    faces.set(key, pending);
  }
  const triangles: number[] = [],
    runs: number[] = [],
    originals: number[] = [];
  for (let run = 0; run < mesh.runOriginalID.length; run++) {
    const begin = triangles.length;
    for (let at = mesh.runIndex[run]; at < mesh.runIndex[run + 1]; at += 3) {
      if (!cancelled.has(at)) triangles.push(...indices.slice(at, at + 3));
    }
    if (begin !== triangles.length) {
      runs.push(begin);
      originals.push(mesh.runOriginalID[run]);
    }
  }
  runs.push(triangles.length);
  const options: MeshOptions = {
    numProp: 3,
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(triangles),
    runIndex: new Uint32Array(runs),
    runOriginalID: new Uint32Array(originals),
    tolerance: 0.00001,
  };
  return new cad.Mesh(options);
}
