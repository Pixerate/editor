import React, { useId, useMemo } from 'react';
import { effectFieldValue, effectParameterFields, type EffectDescription, type EffectFieldOptions } from '@pixerate/editor/effects';
import { parameterLabel, parameterValuesEqual, type ParameterValue } from '@pixerate/editor/parameters';
import { ParameterFieldControl, parameterSelectStyle } from '../parameters/fields';
import { useParameterComponents, resolveParameterComponents, type ParameterComponents } from '../parameters/controls.js';

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
  /** Applies a preset by name. */
  onPresetName?: (name: string) => void;
  /** Optional addon rendered next to the control label (e.g. keyframe toggle button). */
  renderControlAddon?: (control: string) => React.ReactNode;
  /** Families offered by font controls (`format: "font"`); default the system font catalog. */
  fonts?: EffectFieldOptions['fonts'];
  disabled?: boolean;
  className?: string;
  /** Custom host controls (input, slider, select). */
  components?: ParameterComponents;
}

/**
 * The parameter panel of an effect, generated from its JSON Schema controls: sliders for bounded
 * numbers, switches, choices, colour pickers, vectors and text, with each control's description,
 * per-control reset and the effect's presets.
 */
export function EffectParameters({
  description,
  values,
  onChange,
  onReset,
  keyframed,
  onPreset,
  onPresetName,
  renderControlAddon,
  fonts,
  disabled = false,
  className = '',
  components,
}: EffectParametersProps) {
  const fields = useMemo(() => effectParameterFields(description, { fonts }), [description, fonts]);
  const idBase = useId();
  const gesture = React.useRef<string | null>(null);
  const count = React.useRef(0);

  const CustomPresetSelect = resolveParameterComponents(components, useParameterComponents()).select;

  const handlePresetSelect = (name: string) => {
    if (!name) return;
    if (onPresetName) {
      onPresetName(name);
    } else if (onPreset) {
      const preset = description.presets.find((p) => p.name === name);
      if (preset) onPreset({ ...description.defaults, ...preset.values });
    }
  };

  return (
    <div className={`space-y-2 ${className}`} data-effect-parameters={description.id}>
      {(onPreset || onPresetName) && description.presets.length > 0 && (
        CustomPresetSelect ? (
          <CustomPresetSelect
            aria-label={`${description.name} presets`}
            label={`${description.name} presets`}
            value=""
            disabled={disabled}
            className="w-full rounded border border-border px-1 py-0.5 text-xs"
            style={parameterSelectStyle}
            options={[
              { value: '', label: 'Presets…' },
              ...description.presets.map((p) => ({ value: p.name, label: p.name })),
            ]}
            onChange={(name) => handlePresetSelect(String(name))}
          />
        ) : (
          <select
            className="w-full rounded border border-border px-1 py-0.5 text-xs"
            style={parameterSelectStyle}
            aria-label={`${description.name} presets`}
            value=""
            disabled={disabled}
            onChange={(e) => handlePresetSelect(e.currentTarget.value)}
          >
            <option value="" style={parameterSelectStyle}>Presets…</option>
            {description.presets.map((p) => (
              <option key={p.name} value={p.name} style={parameterSelectStyle}>
                {p.name}
              </option>
            ))}
          </select>
        )
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
              {renderControlAddon?.(field.id)}
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
              components={components}
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
