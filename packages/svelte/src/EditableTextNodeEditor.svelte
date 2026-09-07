<script lang="ts">
  import type { Editor, Content, Extensions } from "@tiptap/core";
  import { onDestroy, onMount } from "svelte";
  import Placeholder from "@tiptap/extension-placeholder";
  import { initiateEditor } from "./editor.svelte";

  interface EditorProps {
    class?: string;
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
  }

  let {
    class: className = "",
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
      [
        Placeholder.configure({
          placeholder,
        }),
        ...extensions,
      ],
      {
        editable,
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
    class="pixerate-editor-content prose w-full max-w-none focus:outline-none"
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
</style>
