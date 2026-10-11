import type { ManifoldToplevel, Mesh, MeshOptions } from "manifold-3d";

type Triangle = [number, number, number];

/**
 * Remove a zero-area ABC sheet by splitting its neighbour along the longest
 * edge AC at the intermediate vertex B. Coordinates, surface area, winding,
 * volume and the neighbour's material stay unchanged. Unrepairable faces remain
 * in the mesh so the ordinary export validation can reject them.
 * Input must already have coincident vertices welded and opposite faces removed.
 */
export function repairCollinear(cad: ManifoldToplevel, mesh: Mesh): Mesh {
  const p = mesh.vertProperties,
    stride = mesh.numProp;
  const squaredArea = ([a, b, c]: Triangle): number => {
    const ux = p[b * stride] - p[a * stride],
      uy = p[b * stride + 1] - p[a * stride + 1],
      uz = p[b * stride + 2] - p[a * stride + 2];
    const vx = p[c * stride] - p[a * stride],
      vy = p[c * stride + 1] - p[a * stride + 1],
      vz = p[c * stride + 2] - p[a * stride + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    return nx * nx + ny * ny + nz * nz;
  };
  const squaredLength = (a: number, b: number): number => {
    const x = p[a * stride] - p[b * stride],
      y = p[a * stride + 1] - p[b * stride + 1],
      z = p[a * stride + 2] - p[b * stride + 2];
    return x * x + y * y + z * z;
  };
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const faces: (Triangle | null)[] = [],
    runs: number[] = [];
  const pending: {
    index: number;
    a: number;
    b: number;
    c: number;
    edge: string;
  }[] = [];
  const targetEdges = new Set<string>();
  let run = 0;
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    while (run + 1 < mesh.runOriginalID.length && at >= mesh.runIndex[run + 1])
      run++;
    const face: Triangle = [
      mesh.triVerts[at],
      mesh.triVerts[at + 1],
      mesh.triVerts[at + 2],
    ];
    const index = faces.length;
    faces.push(face);
    runs.push(run);
    if (new Set(face).size !== 3 || squaredArea(face) > 1e-20) continue;
    const edges = [
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
    ].sort(
      (x, y) =>
        squaredLength(face[y[0]], face[y[1]]) -
        squaredLength(face[x[0]], face[x[1]]),
    );
    const [i, j, k] = edges[0],
      a = face[i],
      c = face[j],
      b = face[k];
    const length = squaredLength(a, c);
    const projection =
      ((p[b * stride] - p[a * stride]) * (p[c * stride] - p[a * stride]) +
        (p[b * stride + 1] - p[a * stride + 1]) *
          (p[c * stride + 1] - p[a * stride + 1]) +
        (p[b * stride + 2] - p[a * stride + 2]) *
          (p[c * stride + 2] - p[a * stride + 2])) /
      length;
    if (!Number.isFinite(projection) || projection <= 0 || projection >= 1)
      continue;
    const edge = key(a, c);
    targetEdges.add(edge);
    pending.push({ index, a, b, c, edge });
  }
  if (!pending.length) return mesh;
  // Only index edges involved in a repair, rather than duplicating the full
  // neighbourhood mesh adjacency in WASM-worker memory.
  const adjacent = new Map<string, Set<number>>();
  const register = (index: number, adding: boolean) => {
    const face = faces[index];
    if (!face) return;
    for (let i = 0; i < 3; i++) {
      const edge = key(face[i], face[(i + 1) % 3]);
      if (!targetEdges.has(edge)) continue;
      const set = adjacent.get(edge) ?? new Set<number>();
      if (adding) set.add(index);
      else set.delete(index);
      adjacent.set(edge, set);
    }
  };
  for (let i = 0; i < faces.length; i++) register(i, true);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of pending) {
      if (!faces[candidate.index]) continue;
      const neighbours = adjacent.get(candidate.edge);
      if (
        !neighbours ||
        neighbours.size !== 2 ||
        !neighbours.has(candidate.index)
      )
        continue;
      const neighbourIndex = [...neighbours].find(
        (index) => index !== candidate.index,
      )!;
      const neighbour = faces[neighbourIndex];
      if (!neighbour || squaredArea(neighbour) <= 1e-20) continue;
      let edgeAt = -1;
      for (let i = 0; i < 3; i++)
        if (key(neighbour[i], neighbour[(i + 1) % 3]) === candidate.edge)
          edgeAt = i;
      if (edgeAt < 0) continue;
      const a = neighbour[edgeAt],
        c = neighbour[(edgeAt + 1) % 3],
        d = neighbour[(edgeAt + 2) % 3];
      const first: Triangle = [a, candidate.b, d],
        second: Triangle = [candidate.b, c, d];
      if (squaredArea(first) <= 1e-20 || squaredArea(second) <= 1e-20) continue;
      register(candidate.index, false);
      register(neighbourIndex, false);
      faces[candidate.index] = null;
      faces[neighbourIndex] = first;
      register(neighbourIndex, true);
      const added = faces.length;
      faces.push(second);
      runs.push(runs[neighbourIndex]);
      register(added, true);
      changed = true;
    }
  }
  const buckets: number[][] = Array.from(
    { length: mesh.runOriginalID.length },
    () => [],
  );
  for (let i = 0; i < faces.length; i++)
    if (faces[i]) buckets[runs[i]].push(...faces[i]!);
  const indices: number[] = [],
    runIndex: number[] = [],
    runOriginalID: number[] = [];
  for (let i = 0; i < buckets.length; i++)
    if (buckets[i].length) {
      runIndex.push(indices.length);
      runOriginalID.push(mesh.runOriginalID[i]);
      // Avoid spreading a whole city's run into a JavaScript call argument list.
      for (const vertex of buckets[i]) indices.push(vertex);
    }
  runIndex.push(indices.length);
  const options: MeshOptions = {
    numProp: stride,
    vertProperties: new Float32Array(p),
    triVerts: new Uint32Array(indices),
    runIndex: new Uint32Array(runIndex),
    runOriginalID: new Uint32Array(runOriginalID),
    tolerance: mesh.tolerance,
  };
  return new cad.Mesh(options);
}
