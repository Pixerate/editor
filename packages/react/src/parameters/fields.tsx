import React, { useRef } from 'react';
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
  'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
export const parameterButtonClass =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
const rangeClass = 'h-4 w-full min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50';

type CommitInputProps = { value: string; onCommit: (value: string) => void; multiline?: boolean } & Omit<
  React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'defaultValue'
>;

/** A text box that commits on blur or Enter (Mod+Enter when multiline) and resets on Escape. */
export function ParameterCommitInput({ value, onCommit, multiline, className, onKeyDown, ...rest }: CommitInputProps) {
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (el.value !== value) onCommit(el.value);
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
    key: value,
    defaultValue: value,
    className: className ?? parameterInputClass,
    onBlur: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => commit(e.currentTarget),
    onKeyDown: keyDown,
    ...rest,
  };
  return multiline ? <textarea {...props} className={`${props.className} h-auto min-h-[3.5rem] py-1`} /> : <input type="text" {...props} />;
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
        onCommit={(text) => {
          const n = parseParameterNumberInput(field, text);
          if (n !== null) onChange(n);
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
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${
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

/** A colour picker with a hex box, an alpha slider (with `alpha`) and swatches. */
export function ParameterColor({ field, value, onChange, onGestureStart, onGestureEnd, disabled, id }: ParameterControlProps<ColorParameterField, string>) {
  const picking = useRef(false);
  const alpha = !!field.alpha;
  const hex = normalizeHexColor(value, true) ?? '#000000ff';
  const rgb = hex.slice(0, 7);
  const a = hex.slice(7);
  const off = disabled || field.readOnly;
  const start = () => {
    if (picking.current) return;
    picking.current = true;
    onGestureStart?.();
  };
  const end = () => {
    if (!picking.current) return;
    picking.current = false;
    onGestureEnd?.();
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="relative h-7 w-9 shrink-0 overflow-hidden rounded-md border border-input bg-[repeating-conic-gradient(#d4d4d8_0_25%,#fff_0_50%)] bg-[length:8px_8px]">
          <span className="absolute inset-0" style={{ background: alpha ? hex : rgb }} />
          <input
            type="color"
            aria-label={parameterLabel(field)}
            value={rgb}
            disabled={off}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            onChange={(e) => {
              start();
              onChange(alpha ? `${e.target.value}${a}` : e.target.value);
            }}
            onBlur={end}
          />
        </span>
        <ParameterCommitInput
          id={id}
          aria-label={`${parameterLabel(field)} hex`}
          value={alpha ? hex : rgb}
          disabled={off}
          spellCheck={false}
          className={`${parameterInputClass} font-mono`}
          onCommit={(text) => {
            const next = normalizeHexColor(text, alpha);
            if (next) onChange(next);
          }}
        />
      </div>
      {alpha && (
        <input
          type="range"
          aria-label={`${parameterLabel(field)} opacity`}
          min={0}
          max={255}
          step={1}
          value={parseInt(a, 16)}
          disabled={off}
          className={rangeClass}
          onPointerDown={start}
          onPointerUp={end}
          onPointerCancel={end}
          onBlur={end}
          onChange={(e) => onChange(`${rgb}${Number(e.target.value).toString(16).padStart(2, '0')}`)}
        />
      )}
      {field.swatches && field.swatches.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {field.swatches.map((s) => {
            const swatch = normalizeHexColor(s, alpha);
            if (!swatch) return null;
            return (
              <button
                key={s}
                type="button"
                title={swatch}
                aria-label={`${parameterLabel(field)} ${swatch}`}
                aria-pressed={swatch === (alpha ? hex : rgb)}
                disabled={off}
                onClick={() => onChange(swatch)}
                className="h-5 w-5 rounded border border-input aria-pressed:ring-1 aria-pressed:ring-ring"
                style={{ background: swatch }}
              />
            );
          })}
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
              className="h-9 w-12 overflow-hidden rounded border border-input aria-pressed:ring-2 aria-pressed:ring-ring"
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
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 ${
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

