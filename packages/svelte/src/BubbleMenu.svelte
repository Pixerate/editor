<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { BubbleMenuPlugin, type BubbleMenuPluginProps } from "@tiptap/extension-bubble-menu";

  interface Props {
    editor?: Editor;
    class?: string;
    pluginKey?: any;
    shouldShow?: ((props: any) => boolean) | null;
    updateDelay?: number;
    /** Floating UI options: placement, offset, flip, shift and the rest (TipTap v3; replaces v2's `tippyOptions`). */
    options?: BubbleMenuPluginProps["options"];
    /** Where to append the menu (default: `document.body`). */
    appendTo?: BubbleMenuPluginProps["appendTo"];
    children?: import("svelte").Snippet;
  }

  let {
    editor,
    class: className = "flex h-fit w-fit items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-md",
    pluginKey = "bubbleMenu",
    shouldShow = null,
    updateDelay = 250,
    options = {},
    appendTo = () => document.body,
    children,
  }: Props = $props();

  let menuElement = $state<HTMLElement>();

  $effect(() => {
    if (editor && menuElement) {
      const plugin = BubbleMenuPlugin({
        pluginKey,
        editor,
        element: menuElement,
        appendTo,
        options,
        shouldShow,
        updateDelay,
      });

      editor.registerPlugin(plugin);

      return () => {
        editor.unregisterPlugin(pluginKey);
      };
    }
  });
</script>

<div bind:this={menuElement} class={className} style="visibility: hidden;">
  {#if children}
    {@render children()}
  {/if}
</div>
