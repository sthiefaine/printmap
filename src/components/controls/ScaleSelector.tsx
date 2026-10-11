"use client";

import { useSceneStore } from "@/store/use-scene-store";
import { SCALE_OPTIONS } from "@/lib/constants";

export function ScaleSelector() {
  const scale = useSceneStore((s) => s.scale);
  const setScale = useSceneStore((s) => s.setScale);

  return (
    <select
      value={scale}
      onChange={(e) => setScale(Number(e.target.value))}
      className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {SCALE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value} className="bg-zinc-800">
          {opt.label}
        </option>
      ))}
    </select>
  );
}
