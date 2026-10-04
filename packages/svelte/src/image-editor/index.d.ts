import type { Component } from 'svelte';
import type { ExportOptions, ImageEditorOptions } from '@pixerate/editor';
import type { ReactiveImageEditor } from './imageEditorState.svelte';

export interface ImageEditorProps {
  editor?: ReactiveImageEditor;
  src?: string;
  class?: string;
  style?: string;
  onSave?: (dataUrl: string) => void;
  exportOptions?: ExportOptions;
}

export declare const ImageEditor: Component<ImageEditorProps>;
export declare function createReactiveImageEditor(options?: ImageEditorOptions): ReactiveImageEditor;
export type { ReactiveImageEditor } from './imageEditorState.svelte';
