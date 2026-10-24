import type { ComponentProps } from 'svelte';
import type ColorPickerComponent from './ColorPicker.svelte';

export { default as ColorPicker } from './ColorPicker.svelte';

export type ColorPickerProps = ComponentProps<typeof ColorPickerComponent>;

// Re-export core colour module for consumer convenience
export * from '@pixerate/editor/color';
