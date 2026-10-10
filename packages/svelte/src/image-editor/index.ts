import type { ComponentProps } from "svelte";
import type ImageEditorComponent from "./ImageEditor.svelte";

export { default as ImageEditor } from './ImageEditor.svelte';
export * from './imageEditorState.svelte.js';

export type ImageEditorProps = ComponentProps<typeof ImageEditorComponent>;
