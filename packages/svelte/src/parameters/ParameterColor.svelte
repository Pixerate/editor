<script lang="ts">
  import { normalizeHexColor, parameterLabel, type ColorParameterField } from '@pixerate/editor/parameters';
  import ColorPicker from '../color/ColorPicker.svelte';
  import ParameterCommitInput from './ParameterCommitInput.svelte';
  import { parameterInputClass } from './styles.js';
  import { getParameterComponents, resolveParameterComponents, type ParameterComponents } from './controls.js';

  interface Props {
    field: ColorParameterField;
    value: string;
    onchange: (value: string) => void;
    /** A pick or alpha drag started: merge changes into one undo step until `ongestureend`. */
    ongesturestart?: () => void;
    ongestureend?: () => void;
    disabled?: boolean;
    id?: string;
    components?: ParameterComponents;
  }

  let { field, value, onchange, ongesturestart, ongestureend, disabled = false, id, components }: Props = $props();

  const alpha = $derived(!!field.alpha);
  const hex = $derived(normalizeHexColor(value, true) ?? '#000000ff');
  const rgb = $derived(hex.slice(0, 7));
  const shown = $derived(alpha ? hex : rgb);
  const off = $derived(disabled || !!field.readOnly);
  const name = $derived(parameterLabel(field));
  const context = getParameterComponents();
  const CustomColor = $derived(resolveParameterComponents(components, context).color);

  let open = $state(false);
  let containerEl = $state<HTMLDivElement | null>(null);
  let buttonEl = $state<HTMLButtonElement | null>(null);
  let popoverEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerEl && !containerEl.contains(e.target as Node)) {
        open = false;
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        open = false;
        buttonEl?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });
</script>

<!-- A colour picker with a hex box and a popup ColorPicker, or the host's own colour control. -->
{#if CustomColor}
  <CustomColor {id} value={shown} {alpha} swatches={field.swatches} disabled={off} label={name} {onchange} {ongesturestart} {ongestureend} />
{:else}
  <div bind:this={containerEl} class="relative space-y-1.5">
    <div class="flex items-center gap-2">
      <button
        bind:this={buttonEl}
        type="button"
        aria-label={name}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={off}
        onclick={() => (open = !open)}
        class="relative h-7 w-9 shrink-0 overflow-hidden rounded-md border border-input bg-[repeating-conic-gradient(#d4d4d8_0_25%,#fff_0_50%)] bg-[length:8px_8px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span class="absolute inset-0" style:background={shown}></span>
      </button>
      <ParameterCommitInput
        {id}
        aria-label="{name} hex"
        value={shown}
        disabled={off}
        spellcheck={false}
        class="{parameterInputClass} font-mono"
        oncommit={(text) => {
          const next = normalizeHexColor(text, alpha);
          if (next) onchange(next);
        }}
      />
    </div>
    {#if open}
      <div
        bind:this={popoverEl}
        role="dialog"
        aria-label={name}
        tabindex="-1"
        onfocusout={(e) => {
          if (popoverEl && !popoverEl.contains(e.relatedTarget as Node)) {
            open = false;
          }
        }}
        class="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
        style="background: var(--popover, var(--background, #fff));"
      >
        <ColorPicker
          value={shown}
          {alpha}
          swatches={field.swatches}
          disabled={off}
          {onchange}
          {ongesturestart}
          {ongestureend}
        />
      </div>
    {/if}
  </div>
{/if}
