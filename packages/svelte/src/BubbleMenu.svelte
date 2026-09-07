<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { BubbleMenuPlugin } from "@tiptap/extension-bubble-menu";

  interface Props {
    editor?: Editor;
    class?: string;
    pluginKey?: any;
    shouldShow?: ((props: any) => boolean) | null;
    updateDelay?: number;
    tippyOptions?: Record<string, any>;
    children?: import("svelte").Snippet;
  }

  let {
    editor,
    class: className = "flex h-fit w-fit items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-md",
    pluginKey = "bubbleMenu",
    shouldShow = null,
    updateDelay = 250,
    tippyOptions = {},
    children,
  }: Props = $props();

  let menuElement = $state<HTMLElement>();

  $effect(() => {
    if (editor && menuElement) {
      const plugin = BubbleMenuPlugin({
        pluginKey,
        editor,
        element: menuElement,
        tippyOptions: {
          duration: 100,
          appendTo: () => document.body,
          ...tippyOptions,
        },
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
