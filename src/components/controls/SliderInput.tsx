"use client";
import { useId } from "react";
interface SliderInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
}
export function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit = "",
  decimals = 1,
}: SliderInputProps) {
  const id = useId();
  return (
    <div className="slider-field">
      <div>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value.toFixed(decimals)}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
