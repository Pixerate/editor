import React, { useEffect, useRef, useState } from 'react';
import {
  choiceOptionLabel,
  formatParameterNumber,
  getChoiceOptions,
  isSliderField,
  normalizeHexColor,
  parameterLabel,
  parameterStep,
  parseParameterNumberInput,
  clampParameterNumber,
  vectorComponentField,
  vectorSize,
  type BooleanParameterField,
  type ChoiceParameterField,
  type ColorParameterField,
  type ImageParameterField,
  type NumberParameterField,
  type ParameterField,
  type ParameterKeyState,
  type ParameterValue,
  type TextParameterField,
  type VectorParameterField,
} from '@pixerate/editor/parameters';
import { ColorPicker } from '../color/index.js';

/** Props every field control takes. Controls are controller-free: wire them to anything. */
export interface ParameterControlProps<F extends ParameterField, V extends ParameterValue> {
  field: F;
  value: V;
  onChange: (value: V) => void;
  /** A continuous edit (slider drag, colour pick) started: merge changes into one undo step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  disabled?: boolean;
  /** DOM id of the main input (for a `<label htmlFor>`). */
  id?: string;
}

export const parameterInputClass =
  'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50';
export const parameterButtonClass =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50';
const rangeClass = 'h-4 w-full min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50';

type CommitInputProps = {
  value: string;
  /** Called with the text and the element (e.g. to show the stored value again after a refused edit). */
  onCommit: (value: string, input: HTMLInputElement | HTMLTextAreaElement) => void;
  multiline?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'defaultValue'>;

/** A text box that commits on blur or Enter (Mod+Enter when multiline) and resets on Escape. */
export function ParameterCommitInput({ value, onCommit, multiline, className, onKeyDown, ...rest }: CommitInputProps) {
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (el.value !== value) onCommit(el.value, el);
  };
  const keyDown = (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(e.currentTarget);
    }
    if (e.key === 'Escape') e.currentTarget.value = value;
  };
  const props = {
    defaultValue: value,
    className: className ?? parameterInputClass,
    onBlur: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => commit(e.currentTarget),
    onKeyDown: keyDown,
    ...rest,
  };
  // `key` remounts the box when the value changes from outside.
  return multiline ? (
    <textarea key={value} {...props} className={`${props.className} h-auto min-h-[3.5rem] py-1`} />
  ) : (
    <input key={value} type="text" {...props} />
  );
}

const plainNumber = (field: NumberParameterField, value: number) => formatParameterNumber({ ...field, unit: undefined }, value);

/** A number box: type a value (units allowed), or step with the arrow keys (Shift ×10). */
export function ParameterNumberInput({
  field,
  value,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
}: ParameterControlProps<NumberParameterField, number> & { 'aria-label'?: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <ParameterCommitInput
        id={id}
        inputMode="decimal"
        aria-label={ariaLabel ?? parameterLabel(field)}
        value={plainNumber(field, value)}
        disabled={disabled || field.readOnly}
        className={`${parameterInputClass} ${field.unit ? 'pr-6' : ''}`}
        onCommit={(text, input) => {
          const n = parseParameterNumberInput(field, text);
          // Show the stored value again when the text was not a number or clamps to it.
          if (n === null || n === value) input.value = plainNumber(field, value);
          else onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const step = parameterStep(field) * (e.shiftKey ? 10 : 1);
          onChange(clampParameterNumber(field, value + (e.key === 'ArrowUp' ? step : -step)));
        }}
      />
      {field.unit && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{field.unit}</span>
      )}
    </div>
  );
}

/** A slider plus number box for `number` / `int` fields (number box only for `control: 'input'` or unbounded fields). */
export function ParameterSlider(props: ParameterControlProps<NumberParameterField, number>) {
  const { field, value, onChange, onGestureStart, onGestureEnd, disabled } = props;
  const dragging = useRef(false);
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onGestureEnd?.();
  };
  if (!isSliderField(field)) return <ParameterNumberInput {...props} />;
  const step = parameterStep(field);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label={parameterLabel(field)}
        aria-valuetext={formatParameterNumber(field, value)}
        min={field.min}
        max={field.max}
        step={step}
        value={value}
        disabled={disabled || field.readOnly}
        className={rangeClass}
        onPointerDown={() => {
          if (dragging.current) return;
          dragging.current = true;
          onGestureStart?.();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => onChange(clampParameterNumber(field, Number(e.target.value)))}
      />
      <div className="w-20 shrink-0">
        <ParameterNumberInput {...props} id={props.id} aria-label={`${parameterLabel(field)} value`} />
      </div>
    </div>
  );
}

/** An on/off switch for `boolean` fields. */
export function ParameterToggle({ field, value, onChange, disabled, id }: ParameterControlProps<BooleanParameterField, boolean>) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={value}
      aria-label={parameterLabel(field)}
      disabled={disabled || field.readOnly}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50 ${
        value ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

/** A dropdown (or segmented buttons with `control: 'segmented'`) for `choice` fields. */
export function ParameterSelect({ field, value, onChange, disabled, id }: ParameterControlProps<ChoiceParameterField, string | number>) {
  const options = getChoiceOptions(field);
  const off = disabled || field.readOnly;
  if (field.control === 'segmented') {
    return (
      <div role="radiogroup" aria-label={parameterLabel(field)} className="inline-flex flex-wrap rounded-md border border-input bg-muted p-0.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            title={o.description}
            disabled={off}
            onClick={() => onChange(o.value)}
            className={`rounded px-2 py-0.5 text-xs disabled:opacity-50 ${
              o.value === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {choiceOptionLabel(o)}
          </button>
        ))}
      </div>
    );
  }
  const index = options.findIndex((o) => o.value === value);
  return (
    <select
      id={id}
      aria-label={parameterLabel(field)}
      value={String(index)}
      disabled={off}
      onChange={(e) => {
        const option = options[Number(e.target.value)];
        if (option) onChange(option.value);
      }}
      className={parameterInputClass}
    >
      {options.map((o, i) => (
        <option key={String(o.value)} value={String(i)} title={o.description}>
          {choiceOptionLabel(o)}
        </option>
      ))}
    </select>
  );
}

/** A colour picker with a hex box and a popup ColorPicker. */
export function ParameterColor({ field, value, onChange, onGestureStart, onGestureEnd, disabled, id }: ParameterControlProps<ColorParameterField, string>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const alpha = !!field.alpha;
  const hex = normalizeHexColor(value, true) ?? '#000000ff';
  const rgb = hex.slice(0, 7);
  const shown = alpha ? hex : rgb;
  const off = disabled || field.readOnly;
  const name = parameterLabel(field);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          aria-label={name}
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={off}
          onClick={() => setOpen((prev) => !prev)}
          className="relative h-7 w-9 shrink-0 overflow-hidden rounded-md border border-input bg-[repeating-conic-gradient(#d4d4d8_0_25%,#fff_0_50%)] bg-[length:8px_8px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="absolute inset-0" style={{ background: shown }} />
        </button>
        <ParameterCommitInput
          id={id}
          aria-label={`${name} hex`}
          value={shown}
          disabled={off}
          spellCheck={false}
          className={`${parameterInputClass} font-mono`}
          onCommit={(text) => {
            const next = normalizeHexColor(text, alpha);
            if (next) onChange(next);
          }}
        />
      </div>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={name}
          tabIndex={-1}
          onBlur={(e) => {
            if (popoverRef.current && !popoverRef.current.contains(e.relatedTarget as Node)) {
              setOpen(false);
            }
          }}
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          style={{ background: 'var(--popover, var(--background, #fff))' }}
        >
          <ColorPicker
            value={shown}
            alpha={alpha}
            swatches={field.swatches}
            disabled={off}
            onChange={onChange}
            onGestureStart={onGestureStart}
            onGestureEnd={onGestureEnd}
          />
        </div>
      )}
    </div>
  );
}

/** One number box per component for `vector` fields. */
export function ParameterVector({ field, value, onChange, disabled, id }: ParameterControlProps<VectorParameterField, number[]>) {
  const size = vectorSize(field);
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}>
      {Array.from({ length: size }, (_, i) => {
        const component = vectorComponentField(field, i);
        return (
          <label key={i} className="flex min-w-0 items-center gap-1">
            <span className="w-3 shrink-0 text-[10px] uppercase text-muted-foreground">{component.label}</span>
            <ParameterNumberInput
              field={component}
              value={value[i] ?? 0}
              id={i === 0 ? id : undefined}
              aria-label={`${parameterLabel(field)} ${component.label}`}
              disabled={disabled || field.readOnly}
              onChange={(n) => onChange(Array.from({ length: size }, (_, j) => (j === i ? n : (value[j] ?? 0))))}
            />
          </label>
        );
      })}
    </div>
  );
}

export interface ParameterImageProps extends ParameterControlProps<ImageParameterField, string> {
  /** Turns a picked file into a URL (upload it, or `URL.createObjectURL`). Without it there is no file button. */
  resolveFile?: (file: File) => string | Promise<string>;
}

/** An image picker: suggested thumbnails, a URL box, an optional file button and a clear button. */
export function ParameterImage({ field, value, onChange, disabled, id, resolveFile }: ParameterImageProps) {
  const off = disabled || field.readOnly;
  const name = parameterLabel(field);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-input bg-muted">
          {value ? (
            <img src={value} alt={name} className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] text-muted-foreground">None</span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ParameterCommitInput
            id={id}
            aria-label={`${name} URL`}
            placeholder="Image URL"
            value={value.startsWith('data:') ? '' : value}
            disabled={off}
            onCommit={(text) => onChange(text.trim())}
          />
          <div className="flex gap-1">
            {resolveFile && (
              <label className={`${parameterButtonClass} cursor-pointer ${off ? 'pointer-events-none opacity-50' : ''}`}>
                Choose file…
                <input
                  type="file"
                  className="sr-only"
                  accept={field.accept ?? 'image/*'}
                  disabled={off}
                  aria-label={`${name} file`}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) onChange(await resolveFile(file));
                  }}
                />
              </label>
            )}
            {value && (
              <button type="button" className={parameterButtonClass} disabled={off} onClick={() => onChange('')} aria-label={`Clear ${name}`}>
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
      {field.options && field.options.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {field.options.map((o) => (
            <button
              key={o.url}
              type="button"
              title={o.label ?? o.url}
              aria-label={o.label ?? o.url}
              aria-pressed={o.url === value}
              disabled={off}
              onClick={() => onChange(o.url)}
              className="h-9 w-12 overflow-hidden rounded border border-input aria-pressed:ring-2 aria-pressed:ring-primary"
            >
              <img src={o.url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A text box (or textarea with `multiline`) that commits on blur or Enter. */
export function ParameterText({ field, value, onChange, disabled, id }: ParameterControlProps<TextParameterField, string>) {
  return (
    <ParameterCommitInput
      id={id}
      aria-label={parameterLabel(field)}
      multiline={field.multiline}
      placeholder={field.placeholder}
      maxLength={field.maxLength}
      value={value}
      disabled={disabled || field.readOnly}
      onCommit={onChange}
    />
  );
}

export interface KeyframeDiamondProps {
  state: ParameterKeyState;
  onToggle: () => void;
  /** The parameter's label (for the accessible name). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/** A keyframe toggle: filled when a key sits at the playhead, tinted when the value is animated. */
export function KeyframeDiamond({ state, onToggle, label, disabled, className = '' }: KeyframeDiamondProps) {
  const keyed = state === 'keyed';
  return (
    <button
      type="button"
      data-key-state={state}
      aria-pressed={keyed}
      aria-label={`${keyed ? 'Remove' : 'Add'} keyframe for ${label}`}
      title={keyed ? 'Remove keyframe here' : 'Add keyframe at the playhead'}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-40 ${
        state === 'none' ? 'text-muted-foreground hover:text-foreground' : 'text-amber-500'
      } ${className}`}
    >
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
        <path
          d="M5 0.8 9.2 5 5 9.2 0.8 5Z"
          fill={keyed ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.3"
          opacity={state === 'animated' ? 0.7 : 1}
        />
      </svg>
    </button>
  );
}

export interface ParameterFieldControlProps extends ParameterControlProps<ParameterField, ParameterValue> {
  resolveFile?: ParameterImageProps['resolveFile'];
}

/** The control for any field type. */
export function ParameterFieldControl({ field, value, onChange, resolveFile, ...rest }: ParameterFieldControlProps) {
  const set = onChange as (value: any) => void;
  switch (field.type) {
    case 'number':
    case 'int':
      return <ParameterSlider field={field} value={value as number} onChange={set} {...rest} />;
    case 'boolean':
      return <ParameterToggle field={field} value={value as boolean} onChange={set} {...rest} />;
    case 'choice':
      return <ParameterSelect field={field} value={value as string | number} onChange={set} {...rest} />;
    case 'color':
      return <ParameterColor field={field} value={value as string} onChange={set} {...rest} />;
    case 'vector':
      return <ParameterVector field={field} value={value as number[]} onChange={set} {...rest} />;
    case 'image':
      return <ParameterImage field={field} value={value as string} onChange={set} resolveFile={resolveFile} {...rest} />;
    case 'text':
      return <ParameterText field={field} value={value as string} onChange={set} {...rest} />;
  }
}

