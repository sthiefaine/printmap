"use client";

import dynamic from "next/dynamic";

const Scene3D = dynamic(
  () =>
    import("@/components/viewer/Scene3D").then((m) => ({
      default: m.Scene3D,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Chargement du viewer 3D...
      </div>
    ),
  },
);

export function Scene3DWrapper() {
  return <Scene3D />;
}
