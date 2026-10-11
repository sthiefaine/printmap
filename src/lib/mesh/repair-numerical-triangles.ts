import type { ManifoldToplevel, Mesh } from "manifold-3d";

type Triangle = [number, number, number];
type Point = [number, number, number];

/**
 * Contract only a submicron edge of a numerically zero-area triangle. The link
 * condition, unchanged neighbouring winding and absence of duplicate faces
 * preserve the surface topology, including internal cavity boundaries.
 * Other coordinates and material runs remain unchanged. Input must already be
 * welded by repairCoincident; strict export validation remains required.
 */
export function repairNumericalTriangles(
  cad: ManifoldToplevel,
  mesh: Mesh,
): Mesh {
  const maximumDisplacementMm = 0.0001;
  const p = mesh.vertProperties,
    stride = mesh.numProp;
  const point = (index: number): Point => [
    p[index * stride],
    p[index * stride + 1],
    p[index * stride + 2],
  ];
  const subtract = (a: Point, b: Point): Point =>
    a.map((value, i) => value - b[i]) as Point;
  const dot = (a: Point, b: Point) =>
    a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a: Point, b: Point): Point => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normal = ([a, b, c]: Triangle) =>
    cross(subtract(point(b), point(a)), subtract(point(c), point(a)));
  const areaSquared = (face: Triangle) => dot(normal(face), normal(face));
  const faceKey = (face: Triangle) => [...face].sort((a, b) => a - b).join(":");
  const faces: (Triangle | null)[] = [],
    runs: number[] = [],
    candidates: number[] = [];
  let run = 0;
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    while (run + 1 < mesh.runOriginalID.length && at >= mesh.runIndex[run + 1])
      run++;
    const face: Triangle = [
      mesh.triVerts[at],
      mesh.triVerts[at + 1],
      mesh.triVerts[at + 2],
    ];
    if (areaSquared(face) <= 1e-20) candidates.push(faces.length);
    faces.push(face);
    runs.push(run);
  }
  if (!candidates.length) return mesh;
  let changed = false;
  for (const candidate of candidates) {
    const face = faces[candidate];
    if (!face || areaSquared(face) > 1e-20) continue;
    const edges = [
      [face[0], face[1]],
      [face[1], face[2]],
      [face[2], face[0]],
    ].sort(
      ([a, b], [c, d]) =>
        Math.hypot(...subtract(point(a), point(b))) -
        Math.hypot(...subtract(point(c), point(d))),
    );
    for (const [a, b] of edges) {
      if (
        a === b ||
        Math.hypot(...subtract(point(a), point(b))) > maximumDisplacementMm
      )
        continue;
      const neighboursA = new Set<number>(),
        neighboursB = new Set<number>(),
        shared: number[] = [],
        affected: number[] = [],
        existing = new Map<string, number>();
      for (let i = 0; i < faces.length; i++) {
        const triangle = faces[i];
        if (!triangle) continue;
        existing.set(faceKey(triangle), i);
        if (triangle.includes(a))
          for (const vertex of triangle)
            if (vertex !== a) neighboursA.add(vertex);
        if (triangle.includes(b)) {
          affected.push(i);
          for (const vertex of triangle)
            if (vertex !== b) neighboursB.add(vertex);
          if (triangle.includes(a)) shared.push(i);
        }
      }
      neighboursA.delete(b);
      neighboursB.delete(a);
      const common = [...neighboursA].filter((vertex) =>
        neighboursB.has(vertex),
      );
      if (
        shared.length !== 2 ||
        common.length !== 2 ||
        !shared.includes(candidate)
      )
        continue;
      // A valid link consists of exactly the opposite vertices of the two
      // incident triangles. This excludes pinched or four-face junctions.
      if (
        shared.some((index) =>
          faces[index]!.some(
            (vertex) =>
              vertex !== a && vertex !== b && !common.includes(vertex),
          ),
        )
      )
        continue;
      const direction = (triangle: Triangle): number => {
        for (let side = 0; side < 3; side++) {
          const from = triangle[side],
            to = triangle[(side + 1) % 3];
          if (from === a && to === b) return 1;
          if (from === b && to === a) return -1;
        }
        return 0;
      };
      if (
        shared.reduce((sum, index) => sum + direction(faces[index]!), 0) !== 0
      )
        continue;
      const replacements = new Map<number, Triangle>();
      let valid = true;
      for (const index of affected) {
        if (shared.includes(index)) continue;
        const original = faces[index]!;
        const replacement = original.map((vertex) =>
          vertex === b ? a : vertex,
        ) as Triangle;
        const oldNormal = normal(original),
          newNormal = normal(replacement);
        const duplicate = existing.get(faceKey(replacement));
        if (
          new Set(replacement).size !== 3 ||
          dot(newNormal, newNormal) <= 1e-20 ||
          dot(oldNormal, newNormal) <= 0 ||
          (duplicate != null &&
            duplicate !== index &&
            !shared.includes(duplicate))
        ) {
          valid = false;
          break;
        }
        replacements.set(index, replacement);
      }
      if (!valid) continue;
      for (const index of shared) faces[index] = null;
      for (const [index, replacement] of replacements)
        faces[index] = replacement;
      changed = true;
      break;
    }
  }
  if (!changed) return mesh;
  const indices: number[] = [],
    runIndex: number[] = [],
    runOriginalID: number[] = [];
  let previousRun = -1;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!face) continue;
    if (runs[i] !== previousRun) {
      runIndex.push(indices.length);
      runOriginalID.push(mesh.runOriginalID[runs[i]]);
      previousRun = runs[i];
    }
    indices.push(...face);
  }
  runIndex.push(indices.length);
  return new cad.Mesh({
    numProp: stride,
    vertProperties: new Float32Array(p),
    triVerts: new Uint32Array(indices),
    runIndex: new Uint32Array(runIndex),
    runOriginalID: new Uint32Array(runOriginalID),
    tolerance: mesh.tolerance,
  });
}
