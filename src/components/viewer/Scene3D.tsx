"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import { useMapStore } from "@/store/use-map-store";
import { CityModel } from "./CityModel";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { PrintedLandmark } from "@/types/print";

const LANDMARK_REPRESENTATIONS: Record<
  PrintedLandmark["representation"],
  string
> = {
  "surveyed-solid": "Volume 3D mesuré",
  "surveyed-roof": "Toiture 3D mesurée · façades simplifiées",
  "lidar-roof": "Toiture LiDAR reconstruite · façades simplifiées",
  "osm-roof": "Forme de toiture renseignée · dimensions estimées",
  footprint: "Volume simplifié · empreinte et hauteur",
};

const SHADOW_SETTINGS = {
  enabled: true,
  type: THREE.PCFShadowMap,
  autoUpdate: false,
};
function CameraPosition({
  mode,
  revision,
  landmarkId,
}: {
  mode: "iso" | "top";
  revision: number;
  landmarkId: string;
}) {
  const model = useMapStore((s) => s.model);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  const viewport = useThree((s) => s.size);
  useEffect(() => {
    if (!model) return;
    const d = model.dimensions;
    const landmark = model.landmarks?.find((item) => item.id === landmarkId);
    // Geometry metadata uses east/north/up; Three displays east/up/south.
    const min = landmark
      ? [landmark.min[0], landmark.min[2], -landmark.max[1]]
      : [-d.widthMm / 2, 0, -d.depthMm / 2];
    const max = landmark
      ? [landmark.max[0], landmark.max[2], -landmark.min[1]]
      : [d.widthMm / 2, d.heightMm, d.depthMm / 2];
    const aspect = viewport.width / Math.max(1, viewport.height);
    const target = landmark
      ? new THREE.Vector3(
          ...(min.map((value, axis) => (value + max[axis]) / 2) as [
            number,
            number,
            number,
          ]),
        )
      : new THREE.Vector3(0, d.heightMm * 0.2, 0);
    const direction = new THREE.Vector3(
      ...(mode === "top" ? [0, 1, 0.0001] : [0.7, 0.75, 0.85]),
    ).normalize();
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), direction)
      .normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 42;
    const tanY = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const tanX = tanY * aspect;
    // Fit every corner, including perspective depth, so narrow screens keep
    // the complete printable plate inside the viewport.
    let distance = landmark ? 10 : 1;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          distance = Math.max(
            distance,
            corner.dot(direction) +
              (landmark ? 1.6 : 1.12) *
                Math.max(
                  Math.abs(corner.dot(right)) / tanX,
                  Math.abs(corner.dot(up)) / tanY,
                ),
          );
        }
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    controls?.target.copy(target);
    controls?.update();
    invalidate();
  }, [
    model,
    camera,
    controls,
    mode,
    revision,
    landmarkId,
    viewport.width,
    viewport.height,
    invalidate,
  ]);
  return null;
}

/** Static studio lighting uses the actual printable mesh for every shadow. */
function StudioLighting() {
  const model = useMapStore((s) => s.model);
  const light = useRef<THREE.DirectionalLight>(null);
  const getState = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const span = model
    ? Math.max(model.dimensions.widthMm, model.dimensions.depthMm)
    : 200;
  const height = model?.dimensions.heightMm || 20;
  useEffect(() => {
    light.current?.shadow.camera.updateProjectionMatrix();
    if (light.current) light.current.shadow.needsUpdate = true;
    getState().gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [model, getState, invalidate]);
  return (
    <>
      <color attach="background" args={["#29342f"]} />
      <ambientLight intensity={0.26} />
      <hemisphereLight args={["#e6ecde", "#47574b", 0.55]} />
      <directionalLight
        ref={light}
        castShadow
        position={[-span * 0.8, span * 1.35, span * 0.5]}
        intensity={2.1}
        color="#fff0d8"
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-span * 0.85}
        shadow-camera-right={span * 0.85}
        shadow-camera-top={span * 0.85}
        shadow-camera-bottom={-span * 0.85}
        shadow-camera-near={span * 0.05}
        shadow-camera-far={span * 6}
        shadow-bias={-0.00002}
        shadow-normalBias={(span / 2048) * 0.3}
        shadow-radius={1.4}
        shadow-intensity={0.85}
      />
      <directionalLight
        position={[span, span * 0.5, -span]}
        intensity={0.35}
        color="#c2d8d7"
      />
      {model ? (
        <>
          <mesh
            receiveShadow
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, -0.18, 0]}
          >
            <planeGeometry args={[span * 4, span * 4]} />
            <shadowMaterial color="#101c16" opacity={0.35} depthWrite={false} />
          </mesh>
          <ContactShadows
            position={[0, -0.12, 0]}
            scale={span * 1.7}
            opacity={0.32}
            color="#101c16"
            resolution={512}
            frames={1}
            blur={1.5}
            far={Math.max(5, height * 0.35)}
            smooth={false}
          />
        </>
      ) : null}
    </>
  );
}

export function Scene3D() {
  const [mode, setMode] = useState<"iso" | "top">("iso");
  const [revision, setRevision] = useState(0);
  const [landmarkId, setLandmarkId] = useState("");
  const landmarks = useMapStore((s) => s.model?.landmarks);
  const selectedLandmark = landmarks?.find((item) => item.id === landmarkId);
  return (
    <ErrorBoundary>
      <div className="scene-view">
        <Canvas
          frameloop="demand"
          shadows={SHADOW_SETTINGS}
          dpr={[1, 1.5]}
          camera={{ position: [220, 240, 240], fov: 42, near: 0.1, far: 20000 }}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.92,
          }}
        >
          <StudioLighting />
          <CityModel />
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={10}
            maxDistance={10000}
            maxPolarAngle={Math.PI / 2.03}
          />
          <CameraPosition
            mode={mode}
            revision={revision}
            landmarkId={landmarkId}
          />
        </Canvas>
        <div className="camera-tools" aria-label="Vue 3D">
          <button
            className={mode === "iso" ? "active" : ""}
            onClick={() => {
              setMode("iso");
              setLandmarkId("");
              setRevision((v) => v + 1);
            }}
          >
            Perspective
          </button>
          <button
            className={mode === "top" ? "active" : ""}
            onClick={() => {
              setMode("top");
              setLandmarkId("");
              setRevision((v) => v + 1);
            }}
          >
            Dessus
          </button>
          <button
            onClick={() => {
              setLandmarkId("");
              setRevision((v) => v + 1);
            }}
            aria-label="Recadrer le modèle"
          >
            ⊞
          </button>
        </div>
        {landmarks?.length ? (
          <div className="landmark-view">
            <label>
              Repères de Saint-Étienne
              <select
                aria-label="Voir un monument de Saint-Étienne"
                value={selectedLandmark ? landmarkId : ""}
                onChange={(event) => setLandmarkId(event.target.value)}
              >
                <option value="">Vue d’ensemble</option>
                {landmarks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedLandmark ? (
              <p>{LANDMARK_REPRESENTATIONS[selectedLandmark.representation]}</p>
            ) : null}
          </div>
        ) : null}
        <p className="scene-hint">
          <span className="desktop-hint">
            Glisser pour tourner · molette pour zoomer
          </span>
          <span className="mobile-hint">
            Glisser pour tourner · pincer pour zoomer
          </span>
        </p>
      </div>
    </ErrorBoundary>
  );
}
