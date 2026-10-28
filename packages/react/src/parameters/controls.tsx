import React, { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** Props for a custom text/number input in parameter panels. */
export interface ParameterInputProps {
  id?: string;
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  label?: string;
  inputMode?: string;
  className?: string;
  style?: React.CSSProperties;
  onChange?: (value: string) => void;
  onCommit: (value: string, input?: HTMLInputElement | HTMLTextAreaElement) => void;
  onKeyDown?: React.KeyboardEventHandler;
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
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onStart?: () => void;
  onEnd?: () => void;
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
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: string | number) => void;
}

/**
 * Host custom form controls for parameter panels.
 * Any omitted fall back to the default styled controls.
 */
export interface ParameterComponents {
  input?: ComponentType<ParameterInputProps>;
  slider?: ComponentType<ParameterSliderProps>;
  select?: ComponentType<ParameterSelectProps>;
  Input?: ComponentType<ParameterInputProps>;
  Slider?: ComponentType<ParameterSliderProps>;
  Range?: ComponentType<any>;
  Select?: ComponentType<any>;
}

const ParameterComponentsContext = createContext<ParameterComponents>({});

/** Provides custom parameter controls to child panels in React. */
export function ParameterComponentsProvider({
  components,
  children
}: {
  components: ParameterComponents;
  children?: ReactNode;
}) {
  return <ParameterComponentsContext.Provider value={components}>{children}</ParameterComponentsContext.Provider>;
}

/** Retrieves the parameter custom components from React context. */
export function useParameterComponents(): ParameterComponents {
  return useContext(ParameterComponentsContext);
}

/** Resolves the effective custom components from explicit props and context. */
export function resolveParameterComponents(
  explicit?: ParameterComponents,
  context?: ParameterComponents
): {
  input?: ComponentType<ParameterInputProps>;
  slider?: ComponentType<any>;
  select?: ComponentType<any>;
} {
  const ctx = context ?? {};
  const input = explicit?.input ?? explicit?.Input ?? ctx.input ?? ctx.Input;
  const slider = explicit?.slider ?? explicit?.Slider ?? explicit?.Range ?? ctx.slider ?? ctx.Slider ?? ctx.Range;
  const select = explicit?.select ?? explicit?.Select ?? ctx.select ?? ctx.Select;
  return { input, slider, select };
}
