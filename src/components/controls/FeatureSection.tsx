"use client";
import type { ReactNode } from "react";
import { ColorPicker } from "./ColorPicker";
export function FeatureSection({
  label,
  enabled,
  onToggle,
  color,
  onColorChange,
  children,
  defaultOpen = false,
}: {
  label: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  color: string;
  onColorChange: (value: string) => void;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className={`feature-card ${enabled ? "" : "muted"}`}
      open={defaultOpen || undefined}
    >
      <summary>
        <span className="layer-dot" style={{ background: color }} />
        <span>{label}</span>
        <span className="feature-controls" onClick={(e) => e.stopPropagation()}>
          <ColorPicker
            value={color}
            onChange={onColorChange}
            label={`Couleur : ${label}`}
          />
          <input
            type="checkbox"
            aria-label={`Inclure ${label}`}
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </span>
        <span className="chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="feature-content">{children}</div>
    </details>
  );
}
