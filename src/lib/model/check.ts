import type { MeshData } from "./build";

/** What a slicer needs: every directed edge is used once and matched by
 * exactly one opposite edge, so the surface is closed and consistently
 * oriented. Returns a description of the first defect, or null. */
export function meshDefect(mesh: MeshData): string | null {
  if (!mesh.indices.length) return "maillage vide";
  const vertexCount = mesh.positions.length / 3;
  const edges = new Map<number, number>();
  for (let t = 0; t < mesh.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = mesh.indices[t + e],
        b = mesh.indices[t + ((e + 1) % 3)];
      if (a === b) return `triangle dégénéré ${t / 3}`;
      const key = a * vertexCount + b;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [key, count] of edges) {
    const a = Math.floor(key / vertexCount),
      b = key % vertexCount;
    if (count !== 1) return `arête ${a}-${b} utilisée ${count} fois`;
    if (edges.get(b * vertexCount + a) !== 1) return `arête ouverte ${a}-${b}`;
  }
  return null;
}
