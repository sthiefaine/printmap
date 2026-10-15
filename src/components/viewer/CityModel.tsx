"use client";
import { useMemo, useEffect } from "react";
import * as THREE from "three";
import { useMapStore } from "@/store/use-map-store";
import { PRINT_LAYERS, type PrintPreview } from "@/types/print";

/** Attach worker-owned buffers without copying vertices or traversing faces. */
export function createPreviewGeometry(preview: PrintPreview) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(preview.positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(preview.normals, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(preview.indices, 1));
  for (const group of preview.groups)
    geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(...preview.bounds.min),
    new THREE.Vector3(...preview.bounds.max),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(...preview.sphere.center),
    preview.sphere.radius,
  );
  return geometry;
}

export function CityModel() {
  const model = useMapStore((s) => s.model);
  const preview = model?.preview;
  const geometry = useMemo(
    () => (preview ? createPreviewGeometry(preview) : null),
    [preview],
  );
  const materials = useMemo(
    () =>
      model
        ? PRINT_LAYERS.map(
            (layer) =>
              new THREE.MeshStandardMaterial({
                color: model.colors[layer],
                roughness: layer === "water" ? 0.58 : 0.92,
                metalness: 0,
                flatShading: true,
              }),
          )
        : [],
    [model],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(
    () => () => materials.forEach((material) => material.dispose()),
    [materials],
  );
  return geometry ? (
    <mesh geometry={geometry} material={materials} castShadow receiveShadow />
  ) : null;
}
