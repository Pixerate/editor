<script lang="ts">
  import { clampMenuPosition, runSpreadsheetMenuItem, type SpreadsheetMenuItem } from '@pixerate/editor/spreadsheet';

  // Gap kept between the menu and the viewport edges.
  const VIEWPORT_MARGIN = 4;

  interface Props {
    items: SpreadsheetMenuItem[];
    x: number;
    y: number;
    onClose: () => void;
  }

  let { items, x, y, onClose }: Props = $props();
  let menuEl = $state<HTMLDivElement | null>(null);
  let measured = $state<{ x: number; y: number } | null>(null);
  const position = $derived(measured ?? { x, y });

  // Keep the (fixed) menu inside the viewport: near the right or bottom edge
  // it opens to the left of / above the pointer instead of being cut off.
  $effect(() => {
    void items; // re-measure when the items change
    if (!menuEl || typeof window === 'undefined') return;
    const { width, height } = menuEl.getBoundingClientRect();
    measured = clampMenuPosition(
      { x, y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
      VIEWPORT_MARGIN
    );
  });

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
  style="left: {position.x}px; top: {position.y}px; max-height: calc(100vh - {VIEWPORT_MARGIN * 2}px); overflow-y: auto; background: var(--popover, var(--background, #fff));"
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
      data-checked={item.checked ? '' : undefined}
      disabled={item.disabled}
      class="block w-full px-3 py-1 text-left hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent {item.checked
        ? 'font-semibold'
        : ''}"
      onclick={() => {
        onClose();
        runSpreadsheetMenuItem(item);
      }}
    >
      {item.label}
    </button>
  {/each}
</div>
