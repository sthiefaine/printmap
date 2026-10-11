"use client";
import { useAppStore } from "@/store/use-app-store";
export function SelectionTools() {
  const draw = useAppStore((s) => s.setSelectionTool);
  return (
    <button
      className="button button-secondary"
      onClick={() => draw("rectangle")}
    >
      <span aria-hidden="true">▱</span> Dessiner une zone
    </button>
  );
}
