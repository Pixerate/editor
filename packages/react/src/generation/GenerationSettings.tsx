import React, { useId, useMemo } from 'react';
import {
  getGenerationControls,
  getReferenceSlots,
  getRequestValue,
  parseControlValue,
  removeReference,
  setRequestValue,
  type GenerationControl,
  type GenerationPlan,
  type GenerationReference,
  type GenerationRequest,
  type ModelCapabilities,
  type PlanStrategy,
  type ReferenceRole,
} from '@pixerate/editor/generation';
import { useGenerationPlan } from './useGenerationPlan';

export interface GenerationSettingsProps {
  capabilities: ModelCapabilities;
  /** The request being edited (controlled). */
  value: GenerationRequest;
  onChange: (next: GenerationRequest) => void;
  /** A plan computed elsewhere; otherwise one is computed with `strategy`. */
  plan?: GenerationPlan;
  /** Strategy for the built-in plan (default `nearest`). */
  strategy?: PlanStrategy;
  /** List plan adjustments and errors under the controls (default `true`). */
  showAdjustments?: boolean;
  /** Shows an "Add" button per reference role; you pick the asset and call `onChange`. */
  onAddReference?: (role: ReferenceRole) => void;
  /** Custom rendering of a reference chip (default: its id). */
  renderReference?: (reference: GenerationReference) => React.ReactNode;
  className?: string;
}

const inputClass =
  'w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring';

function Control({
  control,
  value,
  id,
  onValue,
}: {
  control: GenerationControl;
  value: unknown;
  id: string;
  onValue: (value: unknown) => void;
}) {
  const shown = value ?? control.defaultValue;
  if (control.kind === 'checkbox') {
    return (
      <input
        id={id}
        type="checkbox"
        data-field={control.key}
        checked={Boolean(shown)}
        onChange={(e) => onValue(parseControlValue(control, e.target.checked))}
      />
    );
  }
  if (control.kind === 'select') {
    return (
      <select
        id={id}
        data-field={control.key}
        className={inputClass}
        value={shown === undefined ? '' : String(shown)}
        onChange={(e) => onValue(parseControlValue(control, e.target.value))}
      >
        {shown === undefined && <option value="">Default</option>}
        {control.options!.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (control.kind === 'textarea') {
    return (
      <textarea
        id={id}
        data-field={control.key}
        className={inputClass}
        rows={2}
        maxLength={control.maxLength}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onValue(parseControlValue(control, e.target.value))}
      />
    );
  }
  const numeric = typeof shown === 'number' ? shown : undefined;
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type={control.kind === 'range' ? 'range' : 'number'}
        data-field={control.key}
        className={control.kind === 'range' ? 'flex-1' : inputClass}
        min={control.min}
        max={control.max}
        step={control.step ?? 'any'}
        value={numeric ?? (control.kind === 'range' ? (control.min ?? 0) : '')}
        onChange={(e) => onValue(parseControlValue(control, e.target.value))}
      />
      {control.kind === 'range' && (
        <span className="w-10 text-right tabular-nums text-muted-foreground" data-field-value="">
          {numeric ?? '–'}
        </span>
      )}
    </div>
  );
}

/**
 * Headless-styled settings form generated from a model's capabilities:
 * selects for choices, sliders/number inputs for ranges, text areas for
 * negative/system prompts, checkboxes for boolean params, reference slots by
 * role, and the plan's adjustments and errors. Controlled via `value` / `onChange`.
 */
export const GenerationSettings: React.FC<GenerationSettingsProps> = ({
  capabilities,
  value,
  onChange,
  plan: planProp,
  strategy,
  showAdjustments = true,
  onAddReference,
  renderReference,
  className = '',
}) => {
  const baseId = useId();
  const controls = useMemo(() => getGenerationControls(capabilities), [capabilities]);
  const computed = useGenerationPlan(value, capabilities, { strategy });
  const plan = planProp ?? computed;
  const slots = getReferenceSlots(capabilities, value);

  return (
    <div className={`flex flex-col gap-3 text-sm ${className}`} data-generation-settings="" data-model={capabilities.id}>
      {controls.map((control) => {
        const id = `${baseId}-${control.key}`;
        return (
          <div key={control.key} className="flex flex-col gap-1" data-control={control.key}>
            <label htmlFor={id} className="text-xs font-medium text-muted-foreground" title={control.description}>
              {control.label}
            </label>
            <Control
              control={control}
              id={id}
              value={getRequestValue(value, control.key)}
              onValue={(next) => onChange(setRequestValue(value, control.key, next))}
            />
          </div>
        );
      })}

      {slots.map((slot) => (
        <fieldset key={slot.role} className="flex flex-col gap-1" data-reference-role={slot.role}>
          <legend className="text-xs font-medium text-muted-foreground" title={slot.description}>
            {slot.label}{' '}
            <span className="tabular-nums" data-reference-count="">
              ({slot.references.length}/{slot.max})
            </span>
            {slot.min > 0 && <span className="text-destructive"> *</span>}
          </legend>
          <ul className="flex flex-wrap gap-1">
            {slot.references.map((ref) => (
              <li key={ref.id} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5" data-reference-id={ref.id}>
                {renderReference ? renderReference(ref) : <span className="max-w-[10rem] truncate">{ref.id}</span>}
                <button
                  type="button"
                  aria-label={`Remove ${slot.label} ${ref.id}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(removeReference(value, slot.role, ref.id))}
                >
                  ×
                </button>
              </li>
            ))}
            {onAddReference && slot.canAdd && (
              <li>
                <button
                  type="button"
                  className="rounded border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onAddReference(slot.role)}
                >
                  Add
                </button>
              </li>
            )}
          </ul>
        </fieldset>
      ))}

      {showAdjustments && plan.adjustments.length > 0 && (
        <ul role="status" className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-generation-adjustments="">
          {plan.adjustments.map((adjustment, index) => (
            <li key={index} data-adjustment-field={adjustment.field} data-adjustment-kind={adjustment.kind}>
              {adjustment.reason}
            </li>
          ))}
        </ul>
      )}
      {showAdjustments && plan.errors.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 text-xs text-destructive" data-generation-errors="">
          {plan.errors.map((error, index) => (
            <li key={index} data-error-field={error.field}>
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
