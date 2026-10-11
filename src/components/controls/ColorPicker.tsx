"use client";
export function ColorPicker({
  value,
  onChange,
  label = "Couleur de la couche",
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}) {
  return (
    <input
      className="color-picker"
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      title={label}
    />
  );
}
