"use client";
import { useMemo, useEffect } from "react";
import * as THREE from "three";
import { useMapStore } from "@/store/use-map-store";
import { PRINT_LAYERS } from "@/types/print";
export function CityModel() {
  const model = useMapStore((s) => s.model);
  const geometry = useMemo(() => {
    if (!model) return null;
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
  }, [model]);
  const materials = useMemo(
    () =>
      model
        ? PRINT_LAYERS.map(
            (layer) =>
              new THREE.MeshStandardMaterial({
                color: model.colors[layer],
                roughness: layer === "water" ? 0.45 : 0.83,
                metalness: 0,
                flatShading: true,
              }),
          )
        : [],
    [model],
  );
  useEffect(
    () => () => {
      geometry?.dispose();
      materials.forEach((material) => material.dispose());
    },
    [geometry, materials],
  );
  return geometry ? <mesh geometry={geometry} material={materials} /> : null;
}
