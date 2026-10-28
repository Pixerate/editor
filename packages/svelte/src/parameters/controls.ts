import { getContext, setContext, type Component } from 'svelte';

/** Props for a custom text/number input in parameter panels. */
export interface ParameterInputProps {
  id?: string;
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  label?: string;
  inputmode?: string;
  class?: string;
  style?: string;
  oninput?: (value: string) => void;
  onchange?: (value: string) => void;
  oncommit?: (value: string, input?: HTMLInputElement | HTMLTextAreaElement) => void;
  onkeydown?: (e: KeyboardEvent) => void;
}

/** Props for a custom slider in parameter panels. Compatible with `ImageRangeProps`. */
export interface ParameterSliderProps {
  id?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label'?: string;
  label?: string;
  'aria-valuetext'?: string;
  class?: string;
  style?: string;
  oninput?: (value: number) => void;
  onchange?: (value: number) => void;
  ongesturestart?: () => void;
  ongestureend?: () => void;
  onstart?: () => void;
  onend?: () => void;
}

/** One option in a dropdown parameter control. */
export interface ParameterSelectOption {
  value: string | number;
  label: string;
  description?: string;
}

/** Props for a custom select in parameter panels. Compatible with `ImageSelectProps`. */
export interface ParameterSelectProps {
  id?: string;
  value: string | number;
  options: readonly ParameterSelectOption[];
  disabled?: boolean;
  'aria-label'?: string;
  label?: string;
  placeholder?: string;
  class?: string;
  style?: string;
  onchange?: (value: string | number) => void;
}

/**
 * Host custom form controls for parameter panels.
 * Any omitted fall back to the default styled controls.
 */
export interface ParameterComponents {
  input?: Component<ParameterInputProps>;
  slider?: Component<ParameterSliderProps>;
  select?: Component<ParameterSelectProps>;
  Input?: Component<ParameterInputProps>;
  Slider?: Component<ParameterSliderProps>;
  Range?: Component<any>;
  Select?: Component<any>;
}

const KEY = Symbol('pixerate.parameters.components');

/** Sets the parameter custom components in Svelte context for child panels. */
export function setParameterComponents(components: ParameterComponents): ParameterComponents {
  return setContext(KEY, components);
}

/** Retrieves the parameter custom components set in Svelte context, or empty object. */
export function getParameterComponents(): ParameterComponents {
  return getContext<ParameterComponents | undefined>(KEY) ?? {};
}

/** Resolves the effective custom components from explicit props and context. */
export function resolveParameterComponents(explicit?: ParameterComponents): {
  input?: Component<ParameterInputProps>;
  slider?: Component<any>;
  select?: Component<any>;
} {
  const ctx = getParameterComponents();
  const input = explicit?.input ?? explicit?.Input ?? ctx.input ?? ctx.Input;
  const slider = explicit?.slider ?? explicit?.Slider ?? explicit?.Range ?? ctx.slider ?? ctx.Slider ?? ctx.Range;
  const select = explicit?.select ?? explicit?.Select ?? ctx.select ?? ctx.Select;
  return { input, slider, select };
}
