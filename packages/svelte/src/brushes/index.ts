import type { ComponentProps } from 'svelte';
import type BrushEditorComponent from './BrushEditor.svelte';
import type BrushLibraryBrowserComponent from './BrushLibraryBrowser.svelte';
import type BrushLibraryEditorComponent from './BrushLibraryEditor.svelte';

export { default as BrushEditor } from './BrushEditor.svelte';
export { default as BrushLibraryBrowser } from './BrushLibraryBrowser.svelte';
export { default as BrushLibraryEditor } from './BrushLibraryEditor.svelte';
export { brushLibraryState } from './brushLibrary.svelte.js';

export type BrushEditorProps = ComponentProps<typeof BrushEditorComponent>;
export type BrushLibraryBrowserProps = ComponentProps<typeof BrushLibraryBrowserComponent>;
export type BrushLibraryEditorProps = ComponentProps<typeof BrushLibraryEditorComponent>;
