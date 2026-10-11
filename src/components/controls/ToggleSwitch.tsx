"use client";
export function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <label className="toggle-field">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label || "Activer cette couche"}
      />
      <span className="toggle-visual" aria-hidden="true" />
    </label>
  );
}
