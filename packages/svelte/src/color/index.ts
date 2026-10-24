import type { ComponentProps } from 'svelte';
import type ColorPickerComponent from './ColorPicker.svelte';
import type DualColorPickerComponent from './DualColorPicker.svelte';

export { default as ColorPicker } from './ColorPicker.svelte';
export { default as DualColorPicker } from './DualColorPicker.svelte';

export type ColorPickerProps = ComponentProps<typeof ColorPickerComponent>;
export type DualColorPickerProps = ComponentProps<typeof DualColorPickerComponent>;

export {
	createColorScheme,
	resolvedColor,
	type ColorSchemeOptions,
	type ColorSchemeStore
} from './colorScheme.svelte.js';

// Re-export core colour module for consumer convenience
export * from '@pixerate/editor/color';
