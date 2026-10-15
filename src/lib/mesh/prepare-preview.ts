import {
  PRINT_LAYERS,
  type PrintMesh,
  type PrintModel,
  type PrintPreview,
} from "@/types/print";

/** Derive only display data. The source's indices, materials and millimetre/Z
 * positions remain available for exports, without a rotation or buffer alias. */
export function preparePreview(mesh: PrintMesh): PrintPreview {
  if (
    mesh.positions.length % 3 ||
    mesh.indices.length !== mesh.faceLayers.length * 3
  )
    throw new Error("Les buffers de l’aperçu sont incomplets.");
  const positions = new Float32Array(mesh.positions.length);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < positions.length; at += 3) {
    const x = mesh.positions[at],
      y = mesh.positions[at + 2],
      z = -mesh.positions[at + 1];
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  if (!positions.length) {
    min.fill(0);
    max.fill(0);
  }

  // Count then scatter into one allocation, rather than retaining a JS array
  // for every triangle while the final index buffer is allocated as well.
  const counts = new Uint32Array(PRINT_LAYERS.length);
  for (const layer of mesh.faceLayers)
    counts[layer < PRINT_LAYERS.length ? layer : 0] += 3;
  let start = 0;
  const groups = Array.from(counts, (count, materialIndex) => {
    const group = { start, count, materialIndex };
    start += count;
    return group;
  });
  const cursors = Uint32Array.from(groups, (group) => group.start);
  const indices = new Uint32Array(mesh.indices.length);
  for (let face = 0; face < mesh.faceLayers.length; face++) {
    const value = mesh.faceLayers[face];
    const layer = value < PRINT_LAYERS.length ? value : 0;
    const offset = cursors[layer];
    indices[offset] = mesh.indices[face * 3];
    indices[offset + 1] = mesh.indices[face * 3 + 1];
    indices[offset + 2] = mesh.indices[face * 3 + 2];
    cursors[layer] += 3;
  }

  // Match Three's area-weighted indexed normals and Float32 accumulation, in
  // the same material order as the old viewer, without importing Three in the worker.
  const normals = new Float32Array(positions.length);
  for (let at = 0; at < indices.length; at += 3) {
    const a = indices[at] * 3,
      b = indices[at + 1] * 3,
      c = indices[at + 2] * 3;
    const cbx = positions[c] - positions[b],
      cby = positions[c + 1] - positions[b + 1],
      cbz = positions[c + 2] - positions[b + 2];
    const abx = positions[a] - positions[b],
      aby = positions[a + 1] - positions[b + 1],
      abz = positions[a + 2] - positions[b + 2];
    const x = cby * abz - cbz * aby,
      y = cbz * abx - cbx * abz,
      z = cbx * aby - cby * abx;
    normals[a] += x;
    normals[a + 1] += y;
    normals[a + 2] += z;
    normals[b] += x;
    normals[b + 1] += y;
    normals[b + 2] += z;
    normals[c] += x;
    normals[c + 1] += y;
    normals[c + 2] += z;
  }
  for (let at = 0; at < normals.length; at += 3) {
    const x = normals[at],
      y = normals[at + 1],
      z = normals[at + 2];
    const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    normals[at] = x * inverse;
    normals[at + 1] = y * inverse;
    normals[at + 2] = z * inverse;
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2) as [
    number,
    number,
    number,
  ];
  let radiusSquared = 0;
  for (let at = 0; at < positions.length; at += 3) {
    const x = positions[at] - center[0],
      y = positions[at + 1] - center[1],
      z = positions[at + 2] - center[2];
    radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z);
  }
  return {
    positions,
    indices,
    normals,
    groups,
    bounds: { min, max },
    sphere: { center, radius: Math.sqrt(radiusSquared) },
  };
}

/** Each export and display buffer crosses the worker boundary exactly once.
 * Preview arrays never share storage with printable geometry. */
export function printModelTransferables(model: PrintModel): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (mesh: PrintMesh) => {
    buffers.add(mesh.positions.buffer as ArrayBuffer);
    buffers.add(mesh.indices.buffer as ArrayBuffer);
    buffers.add(mesh.faceLayers.buffer as ArrayBuffer);
  };
  add(model);
  for (const tile of model.tiles) add(tile);
  if (model.preview) {
    buffers.add(model.preview.positions.buffer as ArrayBuffer);
    buffers.add(model.preview.indices.buffer as ArrayBuffer);
    buffers.add(model.preview.normals.buffer as ArrayBuffer);
  }
  return [...buffers];
}
