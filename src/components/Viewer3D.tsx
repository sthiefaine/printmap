"use client";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { BuiltModel, BuiltTile, MeshData } from "@/lib/model/build";
import type { LayerId } from "@/lib/model/settings";
import { useAppStore } from "@/store/app-store";

export type ViewAngle = "iso" | "top" | "under";

function Tile({
  tile,
  colors,
  offset,
}: {
  tile: BuiltTile;
  colors: Record<LayerId, string>;
  offset: [number, number];
}) {
  const geometries = useMemo(() => {
    const make = (mesh: MeshData) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(mesh.positions, 3),
      );
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      return geometry;
    };
    return {
      parts: tile.parts.map((part) => ({
        layer: part.layer,
        geometry: make(part),
      })),
      marks: tile.marks ? make(tile.marks) : null,
    };
  }, [tile]);
  useEffect(
    () => () => {
      geometries.parts.forEach(({ geometry }) => geometry.dispose());
      geometries.marks?.dispose();
    },
    [geometries],
  );
  return (
    <group position={[tile.x0 + offset[0], tile.y0 + offset[1], 0]}>
      {geometries.parts.map(({ layer, geometry }) => (
        <mesh key={layer} geometry={geometry}>
          <meshStandardMaterial
            color={colors[layer]}
            flatShading
            roughness={0.85}
            metalness={0}
          />
        </mesh>
      ))}
      {geometries.marks ? (
        <mesh geometry={geometries.marks}>
          <meshBasicMaterial color="#5d564a" />
        </mesh>
      ) : null}
    </group>
  );
}

/** Frame the whole model whenever its size or the requested view changes. */
function Camera({
  width,
  depth,
  height,
  angle,
}: {
  width: number;
  depth: number;
  height: number;
  angle: ViewAngle;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  useEffect(() => {
    const direction = new THREE.Vector3(
      ...(angle === "top"
        ? [0, 1, 0.001]
        : angle === "under"
          ? [0, -1, -0.001]
          : [0.55, 0.8, 0.9]),
    ).normalize();
    const aspect = size.width / Math.max(1, size.height);
    const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const radius = Math.hypot(width, depth, height) / 2;
    const distance =
      (radius / Math.tan(fov / 2) / Math.min(1, aspect)) *
      (angle === "iso" ? 0.95 : 0.85);
    const target = new THREE.Vector3(0, height * 0.2, 0);
    camera.up.set(0, 1, 0);
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    controls?.target.copy(target);
    controls?.update();
    invalidate();
  }, [
    camera,
    controls,
    invalidate,
    size.width,
    size.height,
    width,
    depth,
    height,
    angle,
  ]);
  return null;
}

export default function Viewer3D({
  model,
  angle,
}: {
  model: BuiltModel;
  angle: ViewAngle;
}) {
  const colors = useAppStore((s) => s.settings.colors);
  const exploded = useAppStore((s) => s.exploded);
  const { widthMm, depthMm, cols, rows } = model.layout;
  const gap = exploded ? Math.max(6, Math.max(widthMm, depthMm) * 0.04) : 0;
  const totalW = widthMm + gap * (cols - 1),
    totalD = depthMm + gap * (rows - 1);
  return (
    <Canvas
      frameloop="demand"
      camera={{ fov: 38, near: 2, far: 30000, position: [200, 300, 300] }}
      gl={{ antialias: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#2c3530"]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[-1.2, 2.2, 1.4]} intensity={2.1} />
      <directionalLight position={[1.5, 1, -1]} intensity={0.55} />
      {/* Grazing light from below: shows the key pockets and plate numbers. */}
      <directionalLight position={[1.2, -0.7, 0.9]} intensity={1.4} />
      {/* The model is in millimetres with Z up; three.js looks at Y up. */}
      <group
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-totalW / 2, 0, totalD / 2]}
      >
        {model.tiles.map((tile) => (
          <Tile
            key={tile.label}
            tile={tile}
            colors={colors}
            offset={[tile.col * gap, (rows - 1 - tile.row) * gap]}
          />
        ))}
      </group>
      <OrbitControls makeDefault enableDamping={false} />
      <Camera
        width={totalW}
        depth={totalD}
        height={model.heightMm}
        angle={angle}
      />
    </Canvas>
  );
}
