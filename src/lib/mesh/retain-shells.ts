import type { Manifold, ManifoldToplevel, Mesh } from "manifold-3d";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

/**
 * Remove selected disconnected boundary shells without changing their winding.
 * Negative shells bound internal cavities. Boolean-unioning the decomposed
 * shells treats them as independent solids and fills those cavities again.
 */
export function removeNumericalShells(
  cad: ManifoldToplevel,
  owner: Handles,
  solid: Manifold,
  retain: (component: Manifold) => boolean,
): Manifold {
  const components = solid.decompose();
  try {
    const retained = components.filter(retain);
    if (retained.length === components.length) return solid;
    if (!retained.length)
      return owner.keep(
        new cad.Manifold(
          new cad.Mesh({
            numProp: 3,
            vertProperties: new Float32Array(),
            triVerts: new Uint32Array(),
          }),
        ),
      );
    const meshes = retained.map((component) => component.getMesh());
    const mesh = concatenateShells(cad, meshes);
    const result = owner.keep(new cad.Manifold(mesh));
    if (result.status() !== "NoError")
      throw new Error(
        "Le nettoyage des coques a produit une géométrie invalide.",
      );
    return result;
  } finally {
    for (const component of components) component.delete();
  }
}

function concatenateShells(cad: ManifoldToplevel, meshes: Mesh[]): Mesh {
  const numProp = meshes[0].numProp;
  if (meshes.some((mesh) => mesh.numProp !== numProp))
    throw new Error("Les coques ont des propriétés de sommet incompatibles.");
  const sum = (length: (mesh: Mesh) => number) =>
    meshes.reduce((total, mesh) => total + length(mesh), 0);
  const vertProperties = new Float32Array(
    sum((mesh) => mesh.vertProperties.length),
  );
  const triVerts = new Uint32Array(sum((mesh) => mesh.triVerts.length));
  const mergeFromVert = new Uint32Array(
    sum((mesh) => mesh.mergeFromVert.length),
  );
  const mergeToVert = new Uint32Array(mergeFromVert.length);
  const runCount = sum((mesh) =>
    mesh.runOriginalID.reduce(
      (count, _, run) =>
        count + Number(mesh.runIndex[run + 1] > mesh.runIndex[run]),
      0,
    ),
  );
  const runIndex = new Uint32Array(runCount + 1);
  const runOriginalID = new Uint32Array(runCount);
  const hasTransforms = meshes.some((mesh) => mesh.runTransform.length > 0);
  const runTransform = hasTransforms
    ? new Float32Array(runCount * 12)
    : undefined;
  const faceID = new Uint32Array(triVerts.length / 3);
  let vertexOffset = 0,
    triangleOffset = 0,
    mergeOffset = 0,
    runOffset = 0;
  let tolerance = 0;
  for (const mesh of meshes) {
    vertProperties.set(mesh.vertProperties, vertexOffset * numProp);
    for (let i = 0; i < mesh.triVerts.length; i++)
      triVerts[triangleOffset + i] = mesh.triVerts[i] + vertexOffset;
    for (let i = 0; i < mesh.mergeFromVert.length; i++) {
      mergeFromVert[mergeOffset + i] = mesh.mergeFromVert[i] + vertexOffset;
      mergeToVert[mergeOffset + i] = mesh.mergeToVert[i] + vertexOffset;
    }
    for (let run = 0; run < mesh.runOriginalID.length; run++) {
      if (mesh.runIndex[run + 1] <= mesh.runIndex[run]) continue;
      runIndex[runOffset] = mesh.runIndex[run] + triangleOffset;
      runOriginalID[runOffset] = mesh.runOriginalID[run];
      if (runTransform) {
        const transform = mesh.runTransform.length
          ? mesh.runTransform.subarray(run * 12, run * 12 + 12)
          : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        runTransform.set(transform, runOffset * 12);
      }
      runOffset++;
    }
    if (mesh.faceID.length) faceID.set(mesh.faceID, triangleOffset / 3);
    vertexOffset += mesh.vertProperties.length / numProp;
    triangleOffset += mesh.triVerts.length;
    mergeOffset += mesh.mergeFromVert.length;
    tolerance = Math.max(tolerance, mesh.tolerance);
  }
  runIndex[runCount] = triVerts.length;
  return new cad.Mesh({
    numProp,
    vertProperties,
    triVerts,
    mergeFromVert,
    mergeToVert,
    runIndex,
    runOriginalID,
    runTransform,
    faceID,
    tolerance,
  });
}
