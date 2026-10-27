import { getContext, setContext, type Component } from 'svelte';

/** A checkbox in the image editor's panels. */
export interface ImageCheckboxProps {
  checked: boolean;
  /** The accessible name. */
  label: string;
  disabled?: boolean;
  onchange: (checked: boolean) => void;
  class?: string;
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
  oninput: (value: number) => void;
  /** A drag (or key press) starts. */
  onstart?: () => void;
  /** A drag (or key press) ends. */
  onend?: () => void;
  class?: string;
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
  onchange: (value: string) => void;
  class?: string;
}

/**
 * The host's own form controls for the image editor's panels. Any left out fall back to the
 * editor's plain inputs.
 */
export interface ImageEditorControls {
  Checkbox?: Component<ImageCheckboxProps>;
  Range?: Component<ImageRangeProps>;
  Select?: Component<ImageSelectProps>;
}

const KEY = Symbol('pixerate.image-editor.controls');

/**
 * Makes the image editor's panels below this component use the host's controls (call it while
 * a component initialises, like `setContext`).
 */
export function setImageEditorControls(controls: ImageEditorControls): ImageEditorControls {
  return setContext(KEY, controls);
}

/** The controls set by an ancestor with {@link setImageEditorControls}, or none. */
export function getImageEditorControls(): ImageEditorControls {
  return getContext<ImageEditorControls | undefined>(KEY) ?? {};
}
