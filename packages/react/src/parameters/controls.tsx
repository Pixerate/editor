import React, { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** Props for a custom number input in parameter panels. Call `onCommit` when an edit is done (blur, Enter, Tab). */
export interface ParameterInputProps {
  id?: string;
  /** The stored value as text, without the unit. */
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** The field's label. */
  label: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  className?: string;
  style?: React.CSSProperties;
  /** Commits typed text. Pass the element to have a refused edit show the stored value again. */
  onCommit: (value: string, input?: HTMLInputElement | HTMLTextAreaElement) => void;
  /** Arrow keys step the value (Shift ×10). */
  onKeyDown?: React.KeyboardEventHandler;
}

/** Props for a custom slider in parameter panels. */
export interface ParameterSliderProps {
  id?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  'aria-label'?: string;
  /** The field's label. */
  label: string;
  'aria-valuetext'?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Every change while the value moves. */
  onChange: (value: number) => void;
  /** A drag (or key press) starts: changes until `onGestureEnd` merge into one undo step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

/** One option in a dropdown parameter control. */
export interface ParameterSelectOption {
  value: string | number;
  label: string;
  description?: string;
}

/** Props for a custom select in parameter panels. `onChange` takes an option's `value` (or its string form). */
export interface ParameterSelectProps {
  id?: string;
  value: string | number;
  options: readonly ParameterSelectOption[];
  disabled?: boolean;
  'aria-label'?: string;
  /** The control's label. */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: string | number) => void;
}

/** Host form controls for parameter panels. Any left out fall back to the default controls. */
/** Props for a custom colour control in parameter panels. */
export interface ParameterColorProps {
  id?: string;
  /** `#rrggbb`, or `#rrggbbaa` with `alpha`. */
  value: string;
  /** Whether the field has an alpha channel. */
  alpha?: boolean;
  /** Suggested colours for the field, if it has any. */
  swatches?: readonly string[];
  disabled?: boolean;
  /** The field's label. */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: string) => void;
  /** A pick starts: changes until `onGestureEnd` merge into one undo step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export interface ParameterComponents {
  input?: ComponentType<ParameterInputProps>;
  slider?: ComponentType<ParameterSliderProps>;
  select?: ComponentType<ParameterSelectProps>;
  color?: ComponentType<ParameterColorProps>;
}

const ParameterComponentsContext = createContext<ParameterComponents>({});

/** Makes the parameter panels inside it use the host's controls. */
export function ParameterComponentsProvider({ components, children }: { components: ParameterComponents; children?: ReactNode }) {
  return <ParameterComponentsContext.Provider value={components}>{children}</ParameterComponentsContext.Provider>;
}

/** The controls set by an enclosing {@link ParameterComponentsProvider}, or none. */
export function useParameterComponents(): ParameterComponents {
  return useContext(ParameterComponentsContext);
}

/** The controls to use: each one from `explicit`, else from `context`. */
export function resolveParameterComponents(explicit?: ParameterComponents, context?: ParameterComponents): ParameterComponents {
  return {
    input: explicit?.input ?? context?.input,
    slider: explicit?.slider ?? context?.slider,
    select: explicit?.select ?? context?.select,
    color: explicit?.color ?? context?.color,
  };
}

