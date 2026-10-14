<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    defaultAssetRoleOptions,
    describeAssetMentions,
    findTextMentions,
    getAssetRoleOptions,
    setMentionRoleInText,
    type AssetInfo,
    type AssetMentionChip,
    type AssetRoleOption,
    type ModelCapabilities
  } from '@pixerate/editor/generation';

  interface Props {
    /** Prompt text containing `@asset` / `@asset:role` mentions. */
    content: string;
    /** Called with the text after a role is picked (`@fox` → `@fox:style_ref`). */
    onchange: (next: string) => void;
    /** Mentionable assets; mentions that match none (by id or label) are not shown. */
    assets: readonly AssetInfo[];
    /** The selected model: its roles are offered and mentions are checked against it. */
    capabilities?: ModelCapabilities;
    /** Role options (default: the model's roles, else the built-in roles). */
    roles?: readonly AssetRoleOption[];
    /** Custom chip content (default: the asset label). */
    asset?: Snippet<[AssetMentionChip]>;
    class?: string;
  }

  let { content, onchange, assets, capabilities, roles, asset, class: className = '' }: Props = $props();

  let open = $state<number | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);
  const chips = $derived(describeAssetMentions(findTextMentions(content), assets, capabilities));
  const options = $derived(roles ?? (capabilities ? getAssetRoleOptions(capabilities) : defaultAssetRoleOptions()));

  $effect(() => {
    if (open === null) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootEl?.contains(event.target as Node)) open = null;
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  });

  const pick = (chip: AssetMentionChip, role: string | null) => {
    open = null;
    if (chip.start === undefined) return;
    onchange(setMentionRoleInText(content, chip.start, role));
  };
  const problemOf = (chip: AssetMentionChip) =>
    chip.issues.find((issue) => issue.severity === 'error') ?? chip.issues.find((issue) => issue.severity === 'warning');
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') open = null;
  };
</script>

<!-- Asset mentions as chips with role badges and a role picker popover. -->
{#if chips.length > 0}
  <div bind:this={rootEl} class="flex flex-wrap gap-1.5 {className}" data-asset-mention-chips="">
    {#each chips as chip (`${chip.start}-${chip.index}`)}
      {@const problem = problemOf(chip)}
      {@const isOpen = open === chip.index}
      <span class="relative inline-flex" data-asset-chip={chip.asset.id}>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          title={problem?.message}
          data-issue={problem?.code}
          onclick={() => (open = isOpen ? null : chip.index)}
          onkeydown={onKey}
          class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs {problem?.severity === 'error'
            ? 'border-red-500/60'
            : problem
              ? 'border-amber-500/60'
              : 'border-border'} bg-muted/40 hover:bg-muted"
        >
          <span>{#if asset}{@render asset(chip)}{:else}@{chip.asset.label ?? chip.handle}{/if}</span>
          <span
            class="rounded px-1 text-[10px] uppercase tracking-wide {chip.role ? 'bg-primary/15' : 'opacity-60'}"
            data-role-badge={chip.role ?? ''}>{chip.roleLabel ?? 'No role'}</span
          >
        </button>
        {#if isOpen}
          <div
            role="listbox"
            tabindex="-1"
            aria-label="Role for {chip.asset.label ?? chip.handle}"
            class="absolute left-0 top-full z-50 mt-1 flex min-w-[12rem] flex-col rounded-md border border-border bg-background p-1 text-xs shadow-lg"
            data-role-picker=""
            onkeydown={onKey}
          >
            {#each options as option (option.role)}
              <button
                type="button"
                role="option"
                aria-selected={chip.role === option.role}
                data-role-option={option.role}
                title={option.description}
                onclick={() => pick(chip, option.role)}
                class="flex items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted"
              >
                <span>{option.label}</span>{#if option.accepts?.length}<span class="text-[10px] opacity-60"
                    >{option.accepts.join(', ')}</span
                  >{/if}
              </button>
            {/each}
            <button
              type="button"
              role="option"
              aria-selected={!chip.role}
              data-role-option=""
              onclick={() => pick(chip, null)}
              class="rounded px-2 py-1 text-left opacity-70 hover:bg-muted">No role</button
            >
            {#if chip.issues.length > 0}
              <ul class="mt-1 border-t border-border px-2 pt-1 text-[10px]" data-chip-issues="">
                {#each chip.issues as issue, i (i)}
                  <li class={issue.severity === 'error' ? 'text-red-500' : 'text-amber-500'}>{issue.message}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </span>
    {/each}
  </div>
{/if}
