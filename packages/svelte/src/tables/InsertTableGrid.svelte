<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { createTableMenu, type SvelteTableMenu } from "./tableMenu.svelte.js";

  interface Props {
    editor?: Editor | null;
    /** Grid size offered (default 8 × 8). */
    rows?: number;
    cols?: number;
    /** Insert with a header row (default `true`). */
    withHeaderRow?: boolean;
    class?: string;
    cellClass?: string;
    activeCellClass?: string;
    /** Called after a table was inserted. */
    oninsert?: (size: { rows: number; cols: number }) => void;
  }

  let {
    editor = null,
    rows = 8,
    cols = 8,
    withHeaderRow = true,
    class: className = "inline-flex flex-col gap-1 rounded-md border border-border bg-background p-2 text-xs shadow-md",
    cellClass = "h-4 w-4 rounded-sm border border-border bg-background disabled:opacity-40",
    activeCellClass = "border-primary bg-primary/20",
    oninsert,
  }: Props = $props();

  let table = $state.raw<SvelteTableMenu>(createTableMenu(null));
  $effect(() => {
    const menu = createTableMenu(editor);
    table = menu;
    return () => menu.destroy();
  });

  let hover = $state<{ rows: number; cols: number } | null>(null);
  let status = $derived(table.current.actions.insertTable);
  let disabled = $derived(!editor || !status.enabled);
  let sizes = $derived(
    Array.from({ length: rows * cols }, (_, i) => ({ rows: Math.floor(i / cols) + 1, cols: (i % cols) + 1 })),
  );

  const keepSelection = (event: MouseEvent) => event.preventDefault();

  function insert(size: { rows: number; cols: number }) {
    if (table.run("insertTable", { ...size, withHeaderRow })) oninsert?.(size);
    hover = null;
  }
</script>

<div
  class={className}
  role="group"
  aria-label="Insert table"
  title={disabled ? status.reason : undefined}
  data-insert-table-grid=""
  onmouseleave={() => (hover = null)}
>
  <div
    role="grid"
    aria-label="Table size"
    style="display: grid; grid-template-columns: repeat({cols}, max-content); gap: 2px"
  >
    {#each sizes as size, i (i)}
      {@const active = !!hover && size.rows <= hover.rows && size.cols <= hover.cols}
      <button
        type="button"
        data-rows={size.rows}
        data-cols={size.cols}
        data-active={active}
        aria-label="{size.rows} × {size.cols} table"
        {disabled}
        class={active ? `${cellClass} ${activeCellClass}` : cellClass}
        onmousedown={keepSelection}
        onmouseenter={() => (hover = size)}
        onfocus={() => (hover = size)}
        onclick={() => insert(size)}
      ></button>
    {/each}
  </div>
  <div aria-live="polite" data-testid="insert-table-size">
    {disabled ? status.reason : hover ? `${hover.rows} × ${hover.cols}` : "Insert table"}
  </div>
</div>
