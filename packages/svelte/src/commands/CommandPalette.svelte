<script lang="ts" module>
  // Ids only render while the palette is open (client side), so a counter is enough
  // (`$props.id()` needs Svelte 5.20, newer than our peer range).
  let nextId = 0;
</script>

<script lang="ts">
  import type { CommandPaletteItem } from '@pixerate/editor/commands';
  import type { SvelteCommandPalette } from './palette.svelte.js';

  interface Props {
    /** State from `createCommandPalette`. */
    palette: SvelteCommandPalette;
    placeholder?: string;
    emptyMessage?: string;
    /** Extra classes for the dialog panel. */
    class?: string;
  }

  let {
    palette,
    placeholder = 'Type a command…',
    emptyMessage = 'No matching commands',
    class: className = ''
  }: Props = $props();

  const baseId = `command-palette-${++nextId}`;
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);

  $effect(() => {
    if (palette.open) inputEl?.focus();
  });

  $effect(() => {
    void palette.activeIndex;
    if (!palette.open) return;
    const active = listEl?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest' });
  });

  const segments = (item: CommandPaletteItem) => {
    const marked = new Set(item.labelIndices);
    return Array.from(item.label).map((ch, i) => ({ ch, match: marked.has(i) }));
  };
</script>

{#if palette.open}
  <!-- Headless-styled command palette: Arrow keys move, Enter runs, Escape or a backdrop press closes. -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[15vh]"
    data-command-palette-backdrop=""
    role="presentation"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) palette.setOpen(false);
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      class="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl {className}"
      style="background: var(--popover, var(--background, #fff));"
    >
      <input
        bind:this={inputEl}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={palette.items.length ? optionId(palette.activeIndex) : undefined}
        aria-label="Search commands"
        {placeholder}
        value={palette.query}
        oninput={(e) => palette.setQuery(e.currentTarget.value)}
        onkeydown={(e) => {
          if (palette.handleKeyDown(e)) e.stopPropagation();
        }}
        class="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      {#if palette.items.length === 0}
        <div class="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
      {:else}
        <ul bind:this={listEl} id={listId} role="listbox" aria-label="Commands" class="max-h-80 overflow-y-auto py-1">
          {#each palette.items as item, index (item.id)}
            <li
              id={optionId(index)}
              role="option"
              aria-selected={index === palette.activeIndex}
              aria-disabled={!item.enabled || undefined}
              data-command-id={item.id}
              data-recent={item.recent ? '' : undefined}
              title={item.disabledReason}
              onmousemove={() => index !== palette.activeIndex && palette.setActiveIndex(index)}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => palette.run(item.id)}
              onkeydown={() => {}}
              class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm {index === palette.activeIndex
                ? 'bg-muted'
                : ''} {item.enabled ? '' : 'cursor-default opacity-50'}"
            >
              <span class="min-w-0 flex-1 truncate">
                {#each segments(item) as segment, i (i)}{#if segment.match}<span
                      class="font-semibold text-foreground"
                      data-match="">{segment.ch}</span
                    >{:else}{segment.ch}{/if}{/each}
                {#if item.disabledReason}
                  <span class="ml-2 text-xs text-muted-foreground" data-disabled-reason="">{item.disabledReason}</span>
                {/if}
              </span>
              {#if item.group}
                <span class="shrink-0 text-xs text-muted-foreground">{item.group}</span>
              {/if}
              {#if item.shortcut}
                <kbd class="shrink-0 rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground"
                  >{item.shortcut}</kbd
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}
