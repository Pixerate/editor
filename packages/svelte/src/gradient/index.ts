import type { ComponentProps } from 'svelte';
import type GradientEditorComponent from './GradientEditor.svelte';
import type FillPickerComponent from './FillPicker.svelte';

export { default as GradientEditor } from './GradientEditor.svelte';
export { default as FillPicker } from './FillPicker.svelte';
export type { FillMode } from './types.js';

export type GradientEditorProps = ComponentProps<typeof GradientEditorComponent>;
export type FillPickerProps = ComponentProps<typeof FillPickerComponent>;

export {
	createGradientController,
	type SvelteGradient
} from './gradientController.svelte.js';

// Re-export core gradient module for consumer convenience
export * from '@pixerate/editor/gradient';
