import type { ManifoldToplevel, Mesh } from "manifold-3d";

type Triangle = [number, number, number];
type Point = [number, number, number];

/**
 * Contract short native mesh edges only after proving that the surface link,
 * neighbouring winding and triangle uniqueness are preserved. Separate shells
 * and coincident export contacts are never welded by this operation.
 */
export function contractShortEdges(
  cad: ManifoldToplevel,
  mesh: Mesh,
  maximumDisplacementMm: number,
  preserveNativeTolerance = false,
): Mesh {
  if (!Number.isFinite(maximumDisplacementMm) || maximumDisplacementMm <= 0)
    throw new Error("La précision de contraction est invalide.");
  const stride = mesh.numProp,
    p = mesh.vertProperties,
    count = p.length / stride;
  const parent = new Uint32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < (mesh.mergeFromVert?.length ?? 0); i++)
    parent[root(mesh.mergeFromVert[i])] = root(mesh.mergeToVert[i]);
  const point = (index: number): Point => [
    p[index * stride],
    p[index * stride + 1],
    p[index * stride + 2],
  ];
  const subtract = (a: Point, b: Point): Point =>
    a.map((value, i) => value - b[i]) as Point;
  const cross = (a: Point, b: Point): Point => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Point, b: Point) =>
    a.reduce((sum, value, i) => sum + value * b[i], 0);
  const normal = ([a, b, c]: Triangle) =>
    cross(subtract(point(b), point(a)), subtract(point(c), point(a)));
  const faceKey = (face: Triangle) => [...face].sort((a, b) => a - b).join(":");
  const faces: (Triangle | null)[] = [],
    runs: number[] = [];
  const candidates = new Map<string, [number, number]>();
  let run = 0;
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    while (run + 1 < mesh.runOriginalID.length && at >= mesh.runIndex[run + 1])
      run++;
    const face = Array.from(
      mesh.triVerts.subarray(at, at + 3),
      root,
    ) as Triangle;
    faces.push(face);
    runs.push(run);
    for (let side = 0; side < 3; side++) {
      const a = face[side],
        b = face[(side + 1) % 3];
      if (
        a === b ||
        Math.hypot(...subtract(point(a), point(b))) >= maximumDisplacementMm
      )
        continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      candidates.set(key, [a, b]);
    }
  }
  if (!candidates.size) return mesh;
  // Keep adjacency only at candidate vertices, avoiding a full second copy of
  // a city's mesh graph when only a few numerical edges require contraction.
  const adjacent = new Map<number, Set<number>>();
  for (const [a, b] of candidates.values()) {
    adjacent.set(a, new Set());
    adjacent.set(b, new Set());
  }
  for (let i = 0; i < faces.length; i++)
    for (const vertex of faces[i]!) adjacent.get(vertex)?.add(i);
  const members = new Map<number, number[]>();
  let changed = false;
  for (const [originalA, originalB] of candidates.values()) {
    const a = root(originalA),
      b = root(originalB);
    if (a === b) continue;
    const incidentA = adjacent.get(a),
      incidentB = adjacent.get(b);
    if (!incidentA || !incidentB) continue;
    const allMembers = [...(members.get(a) ?? [a]), ...(members.get(b) ?? [b])];
    if (
      allMembers.some(
        (vertex) =>
          Math.hypot(...subtract(point(vertex), point(a))) >
          maximumDisplacementMm,
      )
    )
      continue;
    const neighboursA = new Set<number>(),
      neighboursB = new Set<number>();
    const shared: number[] = [];
    for (const index of incidentA) {
      const face = faces[index];
      if (!face) continue;
      for (const vertex of face)
        if (vertex !== a && vertex !== b) neighboursA.add(vertex);
    }
    for (const index of incidentB) {
      const face = faces[index];
      if (!face) continue;
      for (const vertex of face)
        if (vertex !== a && vertex !== b) neighboursB.add(vertex);
      if (face.includes(a)) shared.push(index);
    }
    const common = [...neighboursA].filter((vertex) => neighboursB.has(vertex));
    if (
      shared.length !== 2 ||
      common.length !== 2 ||
      shared.some((index) =>
        faces[index]!.some(
          (vertex) => vertex !== a && vertex !== b && !common.includes(vertex),
        ),
      )
    )
      continue;
    const direction = (face: Triangle): number => {
      for (let side = 0; side < 3; side++) {
        const from = face[side],
          to = face[(side + 1) % 3];
        if (from === a && to === b) return 1;
        if (from === b && to === a) return -1;
      }
      return 0;
    };
    if (shared.reduce((sum, index) => sum + direction(faces[index]!), 0) !== 0)
      continue;
    const surviving = new Map<string, number>();
    for (const index of incidentA)
      if (!shared.includes(index) && faces[index])
        surviving.set(faceKey(faces[index]!), index);
    const replacements = new Map<number, Triangle>();
    let valid = true;
    for (const index of incidentB) {
      if (shared.includes(index) || !faces[index]) continue;
      const face = faces[index]!;
      const replacement = face.map((vertex) =>
        vertex === b ? a : vertex,
      ) as Triangle;
      const oldNormal = normal(face),
        newNormal = normal(replacement);
      const key = faceKey(replacement);
      if (
        new Set(replacement).size !== 3 ||
        dot(newNormal, newNormal) <= 1e-20 ||
        dot(oldNormal, newNormal) <= 0 ||
        surviving.has(key)
      ) {
        valid = false;
        break;
      }
      surviving.set(key, index);
      replacements.set(index, replacement);
    }
    if (!valid) continue;
    const affected = new Set([...incidentA, ...incidentB]);
    for (const index of affected)
      if (faces[index])
        for (const vertex of faces[index]!) adjacent.get(vertex)?.delete(index);
    for (const index of shared) faces[index] = null;
    for (const [index, replacement] of replacements) faces[index] = replacement;
    parent[b] = a;
    members.set(a, allMembers);
    members.delete(b);
    for (const index of affected)
      if (faces[index])
        for (const vertex of faces[index]!) adjacent.get(vertex)?.add(index);
    adjacent.delete(b);
    changed = true;
  }
  if (!changed) return mesh;
  const positions: number[] = [],
    indices: number[] = [],
    runIndex: number[] = [],
    runOriginalID: number[] = [];
  const remap = new Map<number, number>();
  let previousRun = -1;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!face) continue;
    if (runs[i] !== previousRun) {
      runIndex.push(indices.length);
      runOriginalID.push(mesh.runOriginalID[runs[i]]);
      previousRun = runs[i];
    }
    for (const vertex of face) {
      let mapped = remap.get(vertex);
      if (mapped == null) {
        mapped = positions.length / stride;
        remap.set(vertex, mapped);
        for (let prop = 0; prop < stride; prop++)
          positions.push(p[vertex * stride + prop]);
      }
      indices.push(mapped);
    }
  }
  runIndex.push(indices.length);
  return new cad.Mesh({
    numProp: stride,
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(indices),
    runIndex: new Uint32Array(runIndex),
    runOriginalID: new Uint32Array(runOriginalID),
    // City unions and tile cuts must not infer new coplanar faces at the
    // contraction bound: that can join a tall wall to its surveyed roof.
    // Source-local repairs retain their established tolerance.
    tolerance: preserveNativeTolerance
      ? mesh.tolerance
      : Math.max(mesh.tolerance, maximumDisplacementMm),
  });
}
