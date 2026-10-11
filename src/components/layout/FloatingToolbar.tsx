"use client";

import { CitySearch } from "@/components/map/CitySearch";
import { SelectionTools } from "@/components/map/SelectionTools";
import { useAppStore } from "@/store/use-app-store";

export function FloatingToolbar() {
  const viewMode = useAppStore((s) => s.viewMode);

  if (viewMode === "preview") return null;

  return (
    <div className="absolute top-4 left-4 right-4 z-20 flex items-center gap-3 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 flex-1 bg-zinc-900/90 backdrop-blur-md rounded-xl px-4 py-2.5 shadow-xl border border-white/10">
        <h1 className="text-sm font-bold text-white whitespace-nowrap">
          PrintMap
        </h1>
        <div className="w-px h-6 bg-white/20" />
        <CitySearch />
        <div className="w-px h-6 bg-white/20" />
        <SelectionTools />
      </div>
    </div>
  );
}
