<script lang="ts">
  import { effectFieldValue, effectParameterFields, type EffectDescription, type EffectFieldOptions } from '@pixerate/editor/effects';
  import { parameterLabel, parameterValuesEqual, type ParameterValue } from '@pixerate/editor/parameters';
  import ParameterFieldControl from '../parameters/ParameterFieldControl.svelte';
  import {
    parameterButtonStyle,
    parameterSelectStyle
  } from '../parameters/styles.js';
  import {
    resolveParameterComponents,
    type ParameterComponents
  } from '../parameters/controls.js';

  interface Props {
    /** The effect's description (`describe`). */
    description: EffectDescription;
    /** Its saved values; controls left out show their defaults. */
    values: Readonly<Record<string, unknown>>;
    /**
     * A control changed. While a slider or colour drag is under way `gesture` is a key unique to
     * that drag, so the host can fold its changes into one undo step; otherwise `null`.
     */
    onchange: (control: string, value: ParameterValue, gesture: string | null) => void;
    /** Resets one control to its default. */
    onreset?: (control: string) => void;
    /** Controls that are keyframed: shown read-only with a note (edit them as keyframes). */
    keyframed?: ReadonlySet<string>;
    /** Applies a preset's values. */
    onpreset?: (values: Readonly<Record<string, unknown>>) => void;
    /** Applies a preset by name. */
    onpresetname?: (name: string) => void;
    /** Optional addon rendered next to the control label (e.g. keyframe toggle button). */
    addon?: import('svelte').Snippet<[string]>;
    /** Families offered by font controls (`format: "font"`); default the system font catalog. */
    fonts?: EffectFieldOptions['fonts'];
    /** Custom host components for inputs, sliders, and selects. */
    components?: ParameterComponents;
    disabled?: boolean;
    class?: string;
  }

  let {
    description,
    values,
    onchange,
    onreset,
    keyframed,
    onpreset,
    onpresetname,
    addon,
    fonts,
    components,
    disabled = false,
    class: className = ''
  }: Props = $props();
  const fields = $derived(effectParameterFields(description, { fonts }));
  const resolvedComponents = $derived(resolveParameterComponents(components));
  const CustomPresetSelect = $derived(resolvedComponents.select);
  const idBase = `fx-${Math.random().toString(36).slice(2, 8)}`;
  let gesture: string | null = null;
  let count = 0;
  function preset(name: string) {
    if (!name) return;
    if (onpresetname) {
      onpresetname(name);
    } else if (onpreset) {
      const p = description.presets.find((x) => x.name === name);
      if (p) onpreset({ ...description.defaults, ...p.values });
    }
  }
</script>

<!--
  The parameter panel of an effect, generated from its JSON Schema controls: sliders for bounded
  numbers, switches, choices, colour pickers, vectors and text, with each control's description,
  per-control reset and the effect's presets.
-->
<div class="space-y-2 {className}" data-effect-parameters={description.id}>
  {#if (onpreset || onpresetname) && description.presets.length > 0}
    {#if CustomPresetSelect}
      <CustomPresetSelect
        aria-label="{description.name} presets"
        label="{description.name} presets"
        value=""
        options={[
          { value: '', label: 'Presets…' },
          ...description.presets.map((p) => ({ value: p.name, label: p.name }))
        ]}
        style={parameterSelectStyle}
        {disabled}
        onchange={(val) => preset(String(val))}
      />
    {:else}
      <select
        class="w-full rounded border border-border bg-transparent px-1 py-0.5 text-xs"
        style={parameterSelectStyle}
        aria-label="{description.name} presets"
        value=""
        {disabled}
        onchange={(e) => preset(e.currentTarget.value)}
      >
        <option value="" style={parameterSelectStyle}>Presets…</option>
        {#each description.presets as p (p.name)}<option value={p.name} style={parameterSelectStyle}>{p.name}</option>{/each}
      </select>
    {/if}
  {/if}
  {#each fields as field (field.id)}
    {@const label = parameterLabel(field)}
    {@const keyed = keyframed?.has(field.id) ?? false}
    {@const value = effectFieldValue(field, values[field.id])}
    <div class="space-y-1" data-effect-control={field.id}>
      <div class="flex items-center gap-1.5">
        <label for="{idBase}-{field.id}" class="min-w-0 flex-1 truncate text-xs font-medium" title={field.description}>{label}</label>
        {#if keyed}<span class="text-[10px] text-muted-foreground">keyframed</span>{/if}
        {#if addon}{@render addon(field.id)}{/if}
        {#if onreset && !keyed && !disabled && !parameterValuesEqual(value, field.default)}
          <button type="button" class="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground" style={parameterButtonStyle} aria-label="Reset {label}" onclick={() => onreset(field.id)}>↺</button>
        {/if}
      </div>
      <ParameterFieldControl
        {field}
        {value}
        id="{idBase}-{field.id}"
        disabled={disabled || keyed}
        {components}
        onchange={(v) => onchange(field.id, v, gesture)}
        ongesturestart={() => (gesture = `${idBase}:${field.id}:${++count}`)}
        ongestureend={() => (gesture = null)}
      />
    </div>
  {/each}
  {#if !fields.length}<p class="text-[11px] text-muted-foreground">No controls.</p>{/if}
</div>
