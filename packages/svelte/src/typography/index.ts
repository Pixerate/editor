import type { ComponentProps } from 'svelte';
import type FontPickerComponent from './FontPicker.svelte';
import type TypographyControlComponent from './TypographyControl.svelte';

export { default as FontPicker } from './FontPicker.svelte';
export { default as TypographyControl } from './TypographyControl.svelte';

export type FontPickerProps = ComponentProps<typeof FontPickerComponent>;
export type TypographyControlProps = ComponentProps<typeof TypographyControlComponent>;

export { fontPickerOf, type FontPickerBinding } from './picker.svelte.js';

// Re-export the core typography module for consumer convenience
export * from '@pixerate/editor/typography';
