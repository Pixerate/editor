<script lang="ts">
  import type { Editor, Content, Extensions, FocusPosition } from "@tiptap/core";
  import type { RichTextPresetOptions, MarkdownOptions, ImageOptions } from "@pixerate/editor";
  import { onDestroy, onMount } from "svelte";
  import { initiateEditor } from "./editor.svelte";

  interface EditorProps {
    class?: string;
    editorClass?: string;
    content?: Content;
    showMenu?: boolean;
    editable?: boolean;
    editor?: Editor;
    extensions?: Extensions;
    onUpdate?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onCreate?: () => void;
    placeholder?: string;
    markdown?: boolean | MarkdownOptions;
    richTextOptions?: RichTextPresetOptions;
    autofocus?: FocusPosition | boolean;
    image?: ImageOptions | boolean;
    uploadImage?: (file: File) => Promise<string> | string;
    onUploadError?: (error: Error, file: File) => void;
  }

  let {
    class: className = "",
    editorClass = "",
    content = undefined,
    showMenu = true,
    editable = true,
    editor = $bindable<Editor | undefined>(),
    extensions = [],
    onUpdate,
    onFocus,
    onBlur,
    onCreate,
    placeholder = "",
    markdown = undefined,
    richTextOptions = {},
    autofocus = false,
    image = undefined,
    uploadImage = undefined,
    onUploadError = undefined,
  }: EditorProps = $props();

  let element = $state<HTMLElement>();

  $effect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  });

  onMount(() => {
    editor = initiateEditor(
      element,
      content,
      extensions,
      {
        richTextOptions: {
          placeholder,
          ...(markdown !== undefined ? { markdown } : {}),
          ...(image !== undefined || uploadImage !== undefined || onUploadError !== undefined
            ? {
                image:
                  image === false
                    ? false
                    : {
                        ...(typeof image === "object" ? image : {}),
                        ...(uploadImage ? { upload: uploadImage } : {}),
                        ...(onUploadError ? { onUploadError } : {}),
                      },
              }
            : {}),
          ...richTextOptions,
        },
        editable,
        autofocus,
        onCreate,
        onUpdate,
        onFocus() {
          if (onFocus) onFocus();
        },
        onBlur() {
          if (onBlur) onBlur();
        },
      }
    );
  });

  onDestroy(() => {
    if (editor) {
      editor.destroy();
    }
  });
</script>

<div class={`pixerate-editor-container ${className}`} draggable="false">
  {#if !editor}
    <div class="flex items-center justify-center p-4 text-sm text-gray-500">
      Loading editor...
    </div>
  {/if}
  <div
    bind:this={element}
    class={`pixerate-editor-content prose dark:prose-invert w-full max-w-none focus:outline-none ${editorClass}`.trim()}
  ></div>
</div>

<style>
  :global(.pixerate-editor-content .is-empty::before) {
    content: attr(data-placeholder);
    float: left;
    color: #9ca3af;
    pointer-events: none;
    height: 0;
  }

  :global(.dark .pixerate-editor-content .is-empty::before),
  :global(html.dark .pixerate-editor-content .is-empty::before) {
    color: #6b7280;
  }
</style>
