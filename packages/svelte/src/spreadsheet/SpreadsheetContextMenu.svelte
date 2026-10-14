<script lang="ts">
  import type { SpreadsheetMenuItem } from '@pixerate/editor';

  interface Props {
    items: SpreadsheetMenuItem[];
    x: number;
    y: number;
    onClose: () => void;
  }

  let { items, x, y, onClose }: Props = $props();
  let menuEl = $state<HTMLDivElement | null>(null);

  // Close on outside press or Escape.
  $effect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (!menuEl?.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
    };
  });
</script>

<!-- The table context menu (sort, filter, freeze, hide, merge, categories, transpose). -->
<div
  bind:this={menuEl}
  role="menu"
  aria-label="Table actions"
  tabindex="-1"
  class="fixed z-50 min-w-[14rem] rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg"
  style="left: {x}px; top: {y}px; background: var(--popover, var(--background, #fff));"
  oncontextmenu={(e) => e.preventDefault()}
  onkeydown={(e) => e.stopPropagation()}
>
  {#each items as item (item.id)}
    {#if item.separatorBefore}
      <div role="separator" class="my-1 h-px bg-border"></div>
    {/if}
    <button
      type="button"
      role="menuitem"
      data-action={item.id}
      disabled={item.disabled}
      class="block w-full px-3 py-1 text-left hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      onclick={() => {
        onClose();
        item.run();
      }}
    >
      {item.label}
    </button>
  {/each}
</div>
