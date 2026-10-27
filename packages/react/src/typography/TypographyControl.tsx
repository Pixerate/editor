import React from "react";
import type { FontSpec } from "@pixerate/editor/typography";
import { FontPickerView, type FontPickerProps } from "./FontPicker";
import { useFontPicker } from "./useFontPicker";

export interface TypographyControlProps extends FontPickerProps {
  /** Accessible label for the group (default "Typography"). */
  "aria-label"?: string;
}

const NUMBER: React.CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "5px 6px",
  borderRadius: "6px",
  border: "1px solid var(--pixerate-font-picker-border, #3a4152)",
  background: "var(--pixerate-font-picker-field-bg, #151922)",
  color: "inherit",
  font: "inherit",
};

function NumberField({
  label,
  unit,
  value,
  step,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 }}>
      <span style={{ opacity: 0.75 }}>
        {label} <span style={{ opacity: 0.6 }}>{unit}</span>
      </span>
      <input
        type="number"
        aria-label={label}
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onCommit(n);
        }}
        style={NUMBER}
      />
    </label>
  );
}

/**
 * Composite inspector control: the {@link FontPicker} plus size (px), line height and letter
 * spacing (em). Emits the whole {@link FontSpec} through `onChange`.
 */
export function TypographyControl({
  value,
  onChange,
  model,
  provider,
  fonts,
  previewText,
  disabled = false,
  "aria-label": ariaLabel = "Typography",
  ...view
}: TypographyControlProps) {
  const { model: m, state } = useFontPicker({ model, provider, fonts, previewText, value, onChange });
  const v: FontSpec = state.value;
  return (
    <FontPickerView model={m} disabled={disabled} aria-label={ariaLabel} {...view}>
      <div style={{ display: "flex", gap: "6px" }}>
        <NumberField label="Font size" unit="px" value={v.size} step={1} min={1} max={1000} disabled={disabled} onCommit={(n) => m.setSize(n)} />
        <NumberField label="Line height" unit="×" value={v.lineHeight ?? 1.5} step={0.05} min={0.5} max={4} disabled={disabled} onCommit={(n) => m.setLineHeight(n)} />
        <NumberField label="Letter spacing" unit="em" value={v.letterSpacing ?? 0} step={0.01} min={-0.5} max={1} disabled={disabled} onCommit={(n) => m.setLetterSpacing(n)} />
      </div>
    </FontPickerView>
  );
}
