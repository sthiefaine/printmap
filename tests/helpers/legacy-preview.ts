import * as THREE from "three";
import { PRINT_LAYERS, type PrintMesh } from "../../src/types/print";

/** Frozen reference: the previous CityModel UI-thread preparation, retained
 * only for equivalence checks and the before/after attachment benchmark. */
export function legacyPreviewGeometry(model: PrintMesh) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(model.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = model.positions[i];
    positions[i + 1] = model.positions[i + 2];
    positions[i + 2] = -model.positions[i + 1];
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const grouped = PRINT_LAYERS.map(() => [] as number[]);
  for (let t = 0; t < model.faceLayers.length; t++) {
    const group = grouped[model.faceLayers[t]] || grouped[0];
    group.push(
      model.indices[t * 3],
      model.indices[t * 3 + 1],
      model.indices[t * 3 + 2],
    );
  }
  const indices = new Uint32Array(model.indices.length);
  let offset = 0;
  grouped.forEach((group, material) => {
    indices.set(group, offset);
    geo.addGroup(offset, group.length, material);
    offset += group.length;
  });
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
