import React from 'react';
import type { ControlSpec } from '@pixerate/editor/image-editor';
import { controlTrackBackground, formatControlValue } from '@pixerate/editor/image-editor';

export interface ControlSliderProps {
  spec: ControlSpec;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Overrides `spec.label` (also the accessible name). */
  label?: string;
}

/** A labelled range input described by a control-table entry. */
export const ControlSlider: React.FC<ControlSliderProps> = ({ spec, value, onChange, disabled, label }) => {
  const name = label ?? spec.label;
  const track = controlTrackBackground(spec);
  return (
    <div data-control-id={spec.id}>
      <div className="flex justify-between text-slate-400 mb-1">
        <span>{name}</span>
        <span className="font-mono">{formatControlValue(spec, value)}</span>
      </div>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        aria-label={name}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500 disabled:opacity-40"
      />
      {track && <div className="h-0.5 rounded-full opacity-70" style={{ background: track }} />}
    </div>
  );
};
