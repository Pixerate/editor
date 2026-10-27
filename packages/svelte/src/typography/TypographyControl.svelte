<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { FontPickerModel, type FontProvider, type FontSpec, type FontSummary } from '@pixerate/editor/typography';
  import FontPicker from './FontPicker.svelte';
  import { fontPickerOf } from './picker.svelte.js';

  interface Props {
    /** The selected font and metrics (controlled). */
    value?: Partial<FontSpec>;
    /** Called with the whole spec when anything changes in the control (or through its agent tools). */
    onchange?: (value: FontSpec) => void;
    onChange?: (value: FontSpec) => void;
    /** An existing model; when given, `provider`, `fonts` and `previewText` are ignored. */
    model?: FontPickerModel;
    provider?: FontProvider;
    fonts?: readonly FontSummary[];
    previewText?: string;
    showPreview?: boolean;
    showCategories?: boolean;
    showWeight?: boolean;
    maxResults?: number;
    disabled?: boolean;
    class?: string;
    className?: string;
    id?: string;
    /** Accessible label for the group (default "Typography"). */
    'aria-label'?: string;
  }

  let {
    value,
    onchange,
    onChange,
    model: external,
    provider,
    fonts,
    previewText,
    disabled = false,
    'aria-label': ariaLabel = 'Typography',
    ...rest
  }: Props = $props();

  const model = untrack(() => external ?? new FontPickerModel({ provider, fonts, value, previewText }));
  const picker = fontPickerOf(model);
  onDestroy(() => picker.destroy());
  if (!untrack(() => external) && untrack(() => provider)) void model.refresh();
  const v = $derived(picker.state.value);

  const numberField =
    'box-sizing:border-box;width:100%;padding:5px 6px;border-radius:6px;border:1px solid var(--pixerate-font-picker-border, #3a4152);background:var(--pixerate-font-picker-field-bg, #151922);color:inherit;font:inherit;';

  function commit(e: Event, set: (n: number) => void) {
    const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(n)) set(n);
  }
</script>

<FontPicker {model} {value} onchange={(next) => (onchange ?? onChange)?.(next)} {disabled} aria-label={ariaLabel} {...rest}>
  <div style="display:flex;gap:6px;">
    <label style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">
      <span style="opacity:0.75;">Font size <span style="opacity:0.6;">px</span></span>
      <input type="number" aria-label="Font size" value={v.size} step="1" min="1" max="1000" {disabled} oninput={(e) => commit(e, (n) => model.setSize(n))} style={numberField} />
    </label>
    <label style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">
      <span style="opacity:0.75;">Line height <span style="opacity:0.6;">×</span></span>
      <input type="number" aria-label="Line height" value={v.lineHeight} step="0.05" min="0.5" max="4" {disabled} oninput={(e) => commit(e, (n) => model.setLineHeight(n))} style={numberField} />
    </label>
    <label style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">
      <span style="opacity:0.75;">Letter spacing <span style="opacity:0.6;">em</span></span>
      <input type="number" aria-label="Letter spacing" value={v.letterSpacing} step="0.01" min="-0.5" max="1" {disabled} oninput={(e) => commit(e, (n) => model.setLetterSpacing(n))} style={numberField} />
    </label>
  </div>
</FontPicker>
