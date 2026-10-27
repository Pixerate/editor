<script lang="ts">
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import {
    FONT_CATEGORIES,
    FONT_CATEGORY_LABELS,
    FontPickerModel,
    type FontCategory,
    type FontProvider,
    type FontSpec,
    type FontStyle,
    type FontSummary
  } from '@pixerate/editor/typography';
  import { fontPickerOf } from './picker.svelte.js';

  interface Props {
    /** The selected font (controlled). */
    value?: Partial<FontSpec>;
    /** Called when the user (or an agent through the model's tools) picks a different font, weight or style. */
    onchange?: (value: FontSpec) => void;
    onChange?: (value: FontSpec) => void;
    /** An existing model; when given, `provider`, `fonts` and `previewText` are ignored. */
    model?: FontPickerModel;
    /** Where fonts come from (fetched on mount). */
    provider?: FontProvider;
    /** A fixed list of fonts. */
    fonts?: readonly FontSummary[];
    /** Text for the live preview. */
    previewText?: string;
    /** Show the live preview (default true). */
    showPreview?: boolean;
    /** Show the category filter (default true). */
    showCategories?: boolean;
    /** Show the weight and style selects (default true). */
    showWeight?: boolean;
    /** Most options rendered at once (default 200); search to reach the rest. */
    maxResults?: number;
    disabled?: boolean;
    class?: string;
    className?: string;
    id?: string;
    /** Accessible label for the group (default "Font picker"). */
    'aria-label'?: string;
    /** Extra controls rendered above the preview (used by `TypographyControl`). */
    children?: Snippet;
  }

  let {
    value,
    onchange,
    onChange,
    model: external,
    provider,
    fonts,
    previewText,
    showPreview = true,
    showCategories = true,
    showWeight = true,
    maxResults = 200,
    disabled = false,
    class: klass,
    className,
    id,
    'aria-label': ariaLabel = 'Font picker',
    children
  }: Props = $props();

  const model = untrack(() => external ?? new FontPickerModel({ provider, fonts, value, previewText }));
  const picker = fontPickerOf(model);
  const offValue = model.onValueChange((v) => (onchange ?? onChange)?.(v));
  onDestroy(() => {
    picker.destroy();
    offValue();
  });
  if (!untrack(() => external) && untrack(() => provider)) void model.refresh();

  $effect(() => {
    const v = value;
    if (v) untrack(() => model.setValue(v));
  });

  const s = $derived(picker.state);
  const shown = $derived(s.results.slice(0, maxResults));
  // The model's getters read its current state; reading `s` first makes them update with it.
  const css = $derived.by(() => {
    void s;
    return model.css;
  });
  const weights = $derived.by(() => {
    void s;
    return model.availableWeights;
  });
  const styles = $derived.by(() => {
    void s;
    return model.availableStyles;
  });
  const status = $derived(
    s.loading
      ? 'Loading fonts…'
      : s.error
        ? `Could not load fonts: ${s.error}`
        : s.loadStatus[s.value.family.toLowerCase()] === 'failed'
          ? `${s.value.family} could not be loaded; a fallback is shown.`
          : ''
  );

  const baseId = `pixerate-font-picker-${Math.random().toString(36).slice(2, 10)}`;
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  let listEl: HTMLUListElement | undefined = $state();

  $effect(() => {
    const i = s.highlighted;
    if (i < 0) return;
    untrack(() => listEl?.ownerDocument.getElementById(optionId(i))?.scrollIntoView?.({ block: 'nearest' }));
  });

  function onKeydown(e: KeyboardEvent) {
    if (model.handleKey(e.key)) e.preventDefault();
  }

  const field =
    'box-sizing:border-box;width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--pixerate-font-picker-border, #3a4152);background:var(--pixerate-font-picker-field-bg, #151922);color:inherit;font:inherit;';
</script>

<div
  {id}
  role="group"
  aria-label={ariaLabel}
  aria-disabled={disabled || undefined}
  class={klass ?? className}
  style="box-sizing:border-box;width:var(--pixerate-font-picker-width, 280px);border-radius:var(--pixerate-font-picker-radius, 8px);background:var(--pixerate-font-picker-bg, #1f2430);color:var(--pixerate-font-picker-fg, #f0f2f5);padding:12px;display:flex;flex-direction:column;gap:8px;font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;font-size:12px;opacity:{disabled
    ? 0.6
    : 1};pointer-events:{disabled ? 'none' : 'auto'};"
>
  <div style="display:flex;gap:6px;">
    <input
      type="text"
      role="combobox"
      aria-label="Search fonts"
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={s.highlighted >= 0 && s.highlighted < shown.length ? optionId(s.highlighted) : undefined}
      placeholder="Search fonts"
      value={s.query}
      {disabled}
      oninput={(e) => model.setQuery((e.currentTarget as HTMLInputElement).value)}
      onkeydown={onKeydown}
      style={field}
    />
    {#if showCategories}
      <select
        aria-label="Font category"
        value={s.category}
        {disabled}
        onchange={(e) => model.setCategory((e.currentTarget as HTMLSelectElement).value as FontCategory | 'all')}
        style="{field}width:auto;"
      >
        {#each ['all', ...FONT_CATEGORIES] as c (c)}
          <option value={c}>{FONT_CATEGORY_LABELS[c as FontCategory | 'all']}</option>
        {/each}
      </select>
    {/if}
  </div>

  <ul
    bind:this={listEl}
    id={listId}
    role="listbox"
    aria-label="Fonts"
    style="list-style:none;margin:0;padding:2px;max-height:var(--pixerate-font-picker-list-height, 180px);overflow-y:auto;border-radius:6px;border:1px solid var(--pixerate-font-picker-border, #3a4152);"
  >
    {#if shown.length === 0}
      <li role="presentation" style="padding:6px 8px;opacity:0.7;">{s.loading ? 'Loading…' : 'No fonts match'}</li>
    {/if}
    {#each shown as font, i (font.family)}
      {@const selected = font.family.toLowerCase() === s.value.family.toLowerCase()}
      {@const highlighted = i === s.highlighted}
      <li
        id={optionId(i)}
        role="option"
        tabindex="-1"
        aria-selected={selected}
        data-highlighted={highlighted || undefined}
        onmousedown={(e) => e.preventDefault()}
        onmouseenter={() => model.setHighlight(i)}
        onclick={() => model.selectFamily(font.family)}
        onkeydown={() => {}}
        style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;background:{selected
          ? 'var(--pixerate-font-picker-selected, #2f3b57)'
          : highlighted
            ? 'var(--pixerate-font-picker-hover, #2a3040)'
            : 'transparent'};"
      >
        <span style="font-family:{model.familyCss(font)};font-size:14px;">{font.family}</span>
        <span style="opacity:0.6;font-size:10px;">{FONT_CATEGORY_LABELS[font.category]}</span>
      </li>
    {/each}
  </ul>

  {#if showWeight}
    <div style="display:flex;gap:6px;">
      <select
        aria-label="Font weight"
        value={s.value.weight}
        {disabled}
        onchange={(e) => model.setWeight(Number((e.currentTarget as HTMLSelectElement).value))}
        style={field}
      >
        {#each weights as w (w)}
          <option value={w}>{w}</option>
        {/each}
      </select>
      <select
        aria-label="Font style"
        value={s.value.style}
        {disabled}
        onchange={(e) => model.setStyle((e.currentTarget as HTMLSelectElement).value as FontStyle)}
        style={field}
      >
        {#each styles as st (st)}
          <option value={st}>{st}</option>
        {/each}
      </select>
    </div>
  {/if}

  {@render children?.()}

  {#if showPreview}
    <div
      aria-label="Font preview"
      style="font-family:{css.fontFamily};font-weight:{css.fontWeight};font-style:{css.fontStyle};font-size:{Math.min(
        s.value.size,
        48
      )}px;line-height:{css.lineHeight};letter-spacing:{css.letterSpacing};padding:6px 4px;overflow-wrap:anywhere;"
    >
      {s.previewText}
    </div>
  {/if}

  <div role="status" aria-live="polite" style="opacity:0.75;">{status}</div>
</div>
