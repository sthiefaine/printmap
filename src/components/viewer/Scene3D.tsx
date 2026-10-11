"use client";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useMapStore } from "@/store/use-map-store";
import { CityModel } from "./CityModel";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
function CameraPosition({
  mode,
  revision,
}: {
  mode: "iso" | "top";
  revision: number;
}) {
  const model = useMapStore((s) => s.model);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  const viewport = useThree((s) => s.size);
  useEffect(() => {
    if (!model) return;
    const d = model.dimensions;
    const maxSize = Math.max(d.widthMm, d.depthMm, d.heightMm * 2);
    const aspect = viewport.width / Math.max(1, viewport.height);
    const distance = maxSize * Math.max(1.25, 1.3 / aspect);
    const target = new THREE.Vector3(0, d.heightMm * 0.2, 0);
    if (mode === "top") camera.position.set(0, distance * 1.35, 0.01);
    else camera.position.set(distance * 0.7, distance * 0.9, distance * 0.85);
    camera.lookAt(target);
    controls?.target.copy(target);
    controls?.update();
  }, [
    model,
    camera,
    controls,
    mode,
    revision,
    viewport.width,
    viewport.height,
  ]);
  return null;
}
export function Scene3D() {
  const model = useMapStore((s) => s.model);
  const [mode, setMode] = useState<"iso" | "top">("iso");
  const [revision, setRevision] = useState(0);
  return (
    <ErrorBoundary>
      <div className="scene-view">
        <Canvas
          dpr={[1, 1.7]}
          camera={{ position: [220, 280, 240], fov: 42, near: 0.1, far: 20000 }}
          gl={{ antialias: true }}
        >
          <color attach="background" args={["#252b2a"]} />
          <ambientLight intensity={1.1} />
          <hemisphereLight args={["#fff6e7", "#566d60", 1.8]} />
          <directionalLight position={[150, 280, 180]} intensity={2.8} />
          <directionalLight position={[-160, 100, -100]} intensity={0.8} />
          <CityModel />
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={10}
            maxDistance={10000}
            maxPolarAngle={Math.PI / 2.03}
          />
          <CameraPosition mode={mode} revision={revision} />
          {model ? (
            <gridHelper
              args={[
                Math.max(model.dimensions.widthMm, model.dimensions.depthMm) *
                  1.6,
                16,
                "#3e4741",
                "#313934",
              ]}
              position={[0, -0.2, 0]}
            />
          ) : null}
        </Canvas>
        <div className="camera-tools" aria-label="Vue 3D">
          <button
            className={mode === "iso" ? "active" : ""}
            onClick={() => {
              setMode("iso");
              setRevision((v) => v + 1);
            }}
          >
            Perspective
          </button>
          <button
            className={mode === "top" ? "active" : ""}
            onClick={() => {
              setMode("top");
              setRevision((v) => v + 1);
            }}
          >
            Dessus
          </button>
          <button
            onClick={() => setRevision((v) => v + 1)}
            aria-label="Recadrer le modèle"
          >
            ⊞
          </button>
        </div>
        <p className="scene-hint">
          Glisser pour tourner · molette pour zoomer · clic droit pour déplacer
        </p>
      </div>
    </ErrorBoundary>
  );
}
