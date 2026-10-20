import React, { useId, useMemo } from 'react';
import { effectFieldValue, effectParameterFields, type EffectDescription } from '@pixerate/editor/effects';
import { parameterLabel, parameterValuesEqual, type ParameterValue } from '@pixerate/editor/parameters';
import { ParameterFieldControl } from '../parameters/fields';

export interface EffectParametersProps {
  /** The effect's description (`describe`). */
  description: EffectDescription;
  /** Its saved values; controls left out show their defaults. */
  values: Readonly<Record<string, unknown>>;
  /**
   * A control changed. While a slider or colour drag is under way `gesture` is a key unique to
   * that drag, so the host can fold its changes into one undo step; otherwise `null`.
   */
  onChange: (control: string, value: ParameterValue, gesture: string | null) => void;
  /** Resets one control to its default. */
  onReset?: (control: string) => void;
  /** Controls that are keyframed: shown read-only with a note (edit them as keyframes). */
  keyframed?: ReadonlySet<string>;
  /** Applies a preset's values. */
  onPreset?: (values: Readonly<Record<string, unknown>>) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The parameter panel of an effect, generated from its JSON Schema controls: sliders for bounded
 * numbers, switches, choices, colour pickers, vectors and text, with each control's description,
 * per-control reset and the effect's presets.
 */
export function EffectParameters({ description, values, onChange, onReset, keyframed, onPreset, disabled = false, className = '' }: EffectParametersProps) {
  const fields = useMemo(() => effectParameterFields(description), [description]);
  const idBase = useId();
  const gesture = React.useRef<string | null>(null);
  const count = React.useRef(0);
  return (
    <div className={`space-y-2 ${className}`} data-effect-parameters={description.id}>
      {onPreset && description.presets.length > 0 && (
        <select
          className="w-full rounded border border-border bg-transparent px-1 py-0.5 text-xs"
          aria-label={`${description.name} presets`}
          value=""
          disabled={disabled}
          onChange={(e) => {
            const preset = description.presets.find((p) => p.name === e.currentTarget.value);
            if (preset) onPreset({ ...description.defaults, ...preset.values });
          }}
        >
          <option value="">Presets…</option>
          {description.presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {fields.map((field) => {
        const label = parameterLabel(field);
        const inputId = `${idBase}-${field.id}`;
        const keyed = keyframed?.has(field.id) ?? false;
        const value = effectFieldValue(field, values[field.id]);
        const changed = !keyed && !parameterValuesEqual(value, field.default);
        return (
          <div key={field.id} className="space-y-1" data-effect-control={field.id}>
            <div className="flex items-center gap-1.5">
              <label htmlFor={inputId} className="min-w-0 flex-1 truncate text-xs font-medium" title={field.description}>
                {label}
              </label>
              {keyed && <span className="text-[10px] text-muted-foreground">keyframed</span>}
              {onReset && changed && !disabled && (
                <button type="button" className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground" aria-label={`Reset ${label}`} onClick={() => onReset(field.id)}>
                  ↺
                </button>
              )}
            </div>
            <ParameterFieldControl
              field={field}
              value={value}
              id={inputId}
              disabled={disabled || keyed}
              onChange={(v) => onChange(field.id, v, gesture.current)}
              onGestureStart={() => (gesture.current = `${idBase}:${field.id}:${++count.current}`)}
              onGestureEnd={() => (gesture.current = null)}
            />
          </div>
        );
      })}
      {!fields.length && <p className="text-[11px] text-muted-foreground">No controls.</p>}
    </div>
  );
}
