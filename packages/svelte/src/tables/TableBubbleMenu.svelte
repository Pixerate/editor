<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Editor } from "@tiptap/core";
  import type { BubbleMenuPluginProps } from "@tiptap/extension-bubble-menu";
  import { shouldShowTableBubbleMenu, type TableToolbarItem } from "@pixerate/editor";
  import BubbleMenu from "../BubbleMenu.svelte";
  import TableToolbar from "./TableToolbar.svelte";

  interface Props {
    editor?: Editor;
    class?: string;
    pluginKey?: any;
    updateDelay?: number;
    /** Floating UI options (TipTap v3; replaces v2's `tippyOptions`). */
    options?: BubbleMenuPluginProps["options"];
    /** Where to append the menu (default: `document.body`). */
    appendTo?: BubbleMenuPluginProps["appendTo"];
    /** Buttons of the default toolbar. */
    items?: readonly TableToolbarItem[];
    /** Custom content (default: a `TableToolbar`). */
    children?: Snippet;
  }

  let {
    editor,
    class: className = "flex h-fit w-fit items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-md",
    pluginKey = "tableBubbleMenu",
    updateDelay = 250,
    options,
    appendTo,
    items,
    children,
  }: Props = $props();
</script>

<!--
  A bubble menu that follows the selection while it is in a table (even a
  collapsed cursor), with the table toolbar or your own children. It uses its
  own plugin key (`tableBubbleMenu`), so it can be combined with the
  formatting `BubbleMenu`.
-->
<BubbleMenu {editor} class={className} {pluginKey} {updateDelay} {options} {appendTo} shouldShow={shouldShowTableBubbleMenu}>
  {#if children}
    {@render children()}
  {:else}
    <TableToolbar {editor} {...items ? { items } : {}} />
  {/if}
</BubbleMenu>
