import { getContext, setContext, type Component } from 'svelte';

/** Props for a custom number input in parameter panels. Call `oncommit` when an edit is done (blur, Enter, Tab). */
export interface ParameterInputProps {
  id?: string;
  /** The stored value as text, without the unit. */
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** The field's label. */
  label: string;
  inputmode?: 'decimal' | 'text' | 'numeric';
  class?: string;
  style?: string;
  /** Commits typed text. Pass the element to have a refused edit show the stored value again. */
  oncommit: (value: string, input?: HTMLInputElement | HTMLTextAreaElement) => void;
  /** Arrow keys step the value (Shift ×10). */
  onkeydown?: (e: KeyboardEvent) => void;
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
  class?: string;
  style?: string;
  /** Every change while the value moves. */
  oninput: (value: number) => void;
  /** A drag (or key press) starts: changes until `ongestureend` merge into one undo step. */
  ongesturestart?: () => void;
  ongestureend?: () => void;
}

/** One option in a dropdown parameter control. */
export interface ParameterSelectOption {
  value: string | number;
  label: string;
  description?: string;
}

/** Props for a custom select in parameter panels. `onchange` takes an option's `value` (or its string form). */
export interface ParameterSelectProps {
  id?: string;
  value: string | number;
  options: readonly ParameterSelectOption[];
  disabled?: boolean;
  'aria-label'?: string;
  /** The control's label. */
  label: string;
  class?: string;
  style?: string;
  onchange: (value: string | number) => void;
}

/** Host form controls for parameter panels. Any left out fall back to the default controls. */
export interface ParameterComponents {
  input?: Component<ParameterInputProps>;
  slider?: Component<ParameterSliderProps>;
  select?: Component<ParameterSelectProps>;
}

const KEY = Symbol('pixerate.parameters.components');

/** Makes the parameter panels below this component use the host's controls (call it while a component initialises). */
export function setParameterComponents(components: ParameterComponents): ParameterComponents {
  return setContext(KEY, components);
}

/** The controls set by an ancestor with {@link setParameterComponents}, or none. */
export function getParameterComponents(): ParameterComponents {
  return getContext<ParameterComponents | undefined>(KEY) ?? {};
}

/** The controls to use: each one from `explicit`, else from `fallback` (default: the context's). */
export function resolveParameterComponents(explicit?: ParameterComponents, fallback: ParameterComponents = getParameterComponents()): ParameterComponents {
  return {
    input: explicit?.input ?? fallback.input,
    slider: explicit?.slider ?? fallback.slider,
    select: explicit?.select ?? fallback.select,
  };
}
