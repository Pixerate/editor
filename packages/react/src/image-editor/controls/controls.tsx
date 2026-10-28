import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { imageColorInputClass, imageSelectClass } from '../styles.js';

/** A checkbox in the image editor's panels. */
export interface ImageCheckboxProps {
  checked: boolean;
  /** The accessible name. */
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

/** A range slider in the image editor's panels. */
export interface ImageRangeProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** The accessible name. */
  label: string;
  disabled?: boolean;
  /** Every change while the value moves. */
  onChange: (value: number) => void;
  /** A drag (or key press) starts. */
  onStart?: () => void;
  /** A drag (or key press) ends. */
  onEnd?: () => void;
  className?: string;
}

/** One choice of an {@link ImageSelectProps}. */
export interface ImageSelectOption {
  value: string;
  label: string;
}

/** A dropdown in the image editor's panels. */
export interface ImageSelectProps {
  value: string;
  options: readonly ImageSelectOption[];
  /** The accessible name. */
  label: string;
  /** Shown when `value` matches no option (e.g. "Add effect…"). */
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}

/** A colour well in the image editor's panels. */
export interface ImageColorProps {
  /** `#rrggbb`, or `#rrggbbaa` with `alpha`. */
  value: string;
  /** The accessible name. */
  label: string;
  /** Whether the colour has an alpha channel. */
  alpha?: boolean;
  disabled?: boolean;
  /** Every change while the colour is picked. */
  onChange: (value: string) => void;
  /** A pick (e.g. a drag in the picker) starts: changes until `onEnd` merge into one undo step. */
  onStart?: () => void;
  onEnd?: () => void;
  className?: string;
}

/**
 * The host's own form controls for the image editor's panels. Any left out fall back to the
 * editor's plain inputs.
 */
export interface ImageEditorControls {
  Checkbox?: ComponentType<ImageCheckboxProps>;
  Range?: ComponentType<ImageRangeProps>;
  Select?: ComponentType<ImageSelectProps>;
  Color?: ComponentType<ImageColorProps>;
}

const ControlsContext = createContext<ImageEditorControls>({});

/** Makes the image editor's panels inside it use the host's controls. */
export function ImageEditorControlsProvider({ controls, children }: { controls: ImageEditorControls; children?: ReactNode }) {
  return <ControlsContext.Provider value={controls}>{children}</ControlsContext.Provider>;
}

/** The controls set by an enclosing {@link ImageEditorControlsProvider}, or none. */
export function useImageEditorControls(): ImageEditorControls {
  return useContext(ControlsContext);
}

/** A checkbox: the host's, or a plain input. */
export function ImageCheckbox(props: ImageCheckboxProps) {
  const Host = useImageEditorControls().Checkbox;
  if (Host) return <Host {...props} />;
  const { checked, label, disabled, onChange, className = '' } = props;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className={`accent-primary ${className}`}
    />
  );
}

/** A range slider: the host's, or a plain input. */
export function ImageRange(props: ImageRangeProps) {
  const Host = useImageEditorControls().Range;
  if (Host) return <Host {...props} />;
  const { value, min, max, step, label, disabled, onChange, onStart, onEnd, className = '' } = props;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onPointerDown={() => onStart?.()}
      onPointerUp={() => onEnd?.()}
      onKeyDown={() => onStart?.()}
      onKeyUp={() => onEnd?.()}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`w-full accent-primary disabled:opacity-40 ${className}`}
    />
  );
}

/** A dropdown: the host's, or a plain select. */
export function ImageSelect(props: ImageSelectProps) {
  const Host = useImageEditorControls().Select;
  if (Host) return <Host {...props} />;
  const { value, options, label, placeholder, disabled, onChange, className = '' } = props;
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={`${imageSelectClass} ${className}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A colour well: the host's, or a plain colour input (which keeps the stored alpha). */
export function ImageColor(props: ImageColorProps) {
  const Host = useImageEditorControls().Color;
  if (Host) return <Host {...props} />;
  const { value, label, alpha, disabled, onChange, className = '' } = props;
  return (
    <input
      type="color"
      aria-label={label}
      value={value.slice(0, 7)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value + (alpha ? value.slice(7, 9) : ''))}
      className={`${imageColorInputClass} ${className}`}
    />
  );
}
