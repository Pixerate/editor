<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { DEFAULT_TABLE_TOOLBAR, type TableToolbarItem } from "@pixerate/editor";
  import { createTableMenu, type SvelteTableMenu } from "./tableMenu.svelte.js";

  interface Props {
    editor?: Editor | null;
    /** Buttons to show (default `DEFAULT_TABLE_TOOLBAR`). */
    items?: readonly TableToolbarItem[];
    /** Render (with disabled buttons) when the selection is not in a table. Default `false`. */
    showWhenOutside?: boolean;
    class?: string;
    buttonClass?: string;
    activeButtonClass?: string;
    separatorClass?: string;
    /** Called after a button ran its action. */
    onaction?: (item: TableToolbarItem) => void;
  }

  let {
    editor = null,
    items = DEFAULT_TABLE_TOOLBAR,
    showWhenOutside = false,
    class: className = "flex flex-wrap items-center gap-1 text-xs",
    buttonClass = "rounded px-2 py-1 text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
    activeButtonClass = "bg-primary/10 text-primary",
    separatorClass = "mx-1 h-4 w-px bg-border",
    onaction,
  }: Props = $props();

  let table = $state.raw<SvelteTableMenu>(createTableMenu(null));
  $effect(() => {
    const menu = createTableMenu(editor);
    table = menu;
    return () => menu.destroy();
  });

  // Recomputed whenever the table state changes.
  let buttons = $derived.by(() => {
    const state = table.current;
    return items.map((item, index) => {
      const status = table.check(item.action, item.params);
      return {
        item,
        enabled: status === true,
        title: status === true ? item.title : `${item.title}: ${status}`,
        active: item.active ? item.active(state) : undefined,
        separator: index > 0 && items[index - 1].group !== item.group,
      };
    });
  });

  const keepSelection = (event: MouseEvent) => event.preventDefault();

  function run(item: TableToolbarItem) {
    if (table.run(item.action, item.params)) onaction?.(item);
  }
</script>

{#if editor && (table.current.inTable || showWhenOutside)}
  <div class={className} role="toolbar" aria-label="Table" data-table-toolbar="">
    {#each buttons as button (button.item.id)}
      {#if button.separator}
        <span class={separatorClass} aria-hidden="true"></span>
      {/if}
      <button
        type="button"
        data-action={button.item.id}
        aria-label={button.item.title}
        title={button.title}
        aria-pressed={button.active === undefined ? undefined : button.active}
        disabled={!button.enabled}
        class={button.active ? `${buttonClass} ${activeButtonClass}` : buttonClass}
        onmousedown={keepSelection}
        onclick={() => run(button.item)}
      >
        {button.item.label}
      </button>
    {/each}
  </div>
{/if}
