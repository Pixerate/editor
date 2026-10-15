<script lang="ts">
  import { normalizeHexColor, parameterLabel, type ColorParameterField } from '@pixerate/editor/parameters';
  import ParameterCommitInput from './ParameterCommitInput.svelte';
  import { parameterInputClass, parameterRangeClass } from './styles.js';

  interface Props {
    field: ColorParameterField;
    value: string;
    onchange: (value: string) => void;
    /** A pick or alpha drag started: merge changes into one undo step until `ongestureend`. */
    ongesturestart?: () => void;
    ongestureend?: () => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, ongesturestart, ongestureend, disabled = false, id }: Props = $props();

  const alpha = $derived(!!field.alpha);
  const hex = $derived(normalizeHexColor(value, true) ?? '#000000ff');
  const rgb = $derived(hex.slice(0, 7));
  const a = $derived(hex.slice(7));
  const shown = $derived(alpha ? hex : rgb);
  const off = $derived(disabled || !!field.readOnly);
  const name = $derived(parameterLabel(field));

  let picking = false;
  function start() {
    if (picking) return;
    picking = true;
    ongesturestart?.();
  }
  function end() {
    if (!picking) return;
    picking = false;
    ongestureend?.();
  }
</script>

<!-- A colour picker with a hex box, an alpha slider (with `alpha`) and swatches. -->
<div class="space-y-1.5">
  <div class="flex items-center gap-2">
    <span
      class="relative h-7 w-9 shrink-0 overflow-hidden rounded-md border border-input bg-[repeating-conic-gradient(#d4d4d8_0_25%,#fff_0_50%)] bg-[length:8px_8px]"
    >
      <span class="absolute inset-0" style:background={shown}></span>
      <input
        type="color"
        aria-label={name}
        value={rgb}
        disabled={off}
        class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        oninput={(e) => {
          start();
          onchange(alpha ? `${e.currentTarget.value}${a}` : e.currentTarget.value);
        }}
        onblur={end}
      />
    </span>
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
  {#if alpha}
    <input
      type="range"
      aria-label="{name} opacity"
      min="0"
      max="255"
      step="1"
      value={parseInt(a, 16)}
      disabled={off}
      class={parameterRangeClass}
      onpointerdown={start}
      onpointerup={end}
      onpointercancel={end}
      onblur={end}
      oninput={(e) => onchange(`${rgb}${Number(e.currentTarget.value).toString(16).padStart(2, '0')}`)}
    />
  {/if}
  {#if field.swatches && field.swatches.length > 0}
    <div class="flex flex-wrap gap-1">
      {#each field.swatches as s (s)}
        {@const swatch = normalizeHexColor(s, alpha)}
        {#if swatch}
          <button
            type="button"
            title={swatch}
            aria-label="{name} {swatch}"
            aria-pressed={swatch === shown}
            disabled={off}
            onclick={() => onchange(swatch)}
            class="h-5 w-5 rounded border border-input aria-pressed:ring-1 aria-pressed:ring-ring"
            style:background={swatch}
          ></button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
