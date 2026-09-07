<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import BubbleMenuPlugin from "@tiptap/extension-bubble-menu";
  import { onMount, onDestroy } from "svelte";

  interface Props {
    editor?: Editor;
    class?: string;
    children?: import("svelte").Snippet;
  }

  let {
    editor,
    class: className = "flex items-center gap-1 bg-white border border-gray-200 shadow-md rounded-md p-1",
    children,
  }: Props = $props();

  let menuElement = $state<HTMLElement>();

  onMount(() => {
    if (editor && menuElement) {
      editor.registerPlugin(
        BubbleMenuPlugin.configure({
          element: menuElement,
          tippyOptions: { duration: 100 },
        })
      );
    }
  });

  onDestroy(() => {
    if (editor) {
      editor.unregisterPlugin("bubbleMenu");
    }
  });
</script>

<div bind:this={menuElement} class={className}>
  {#if children}
    {@render children()}
  {/if}
</div>
