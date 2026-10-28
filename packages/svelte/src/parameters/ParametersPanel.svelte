<script lang="ts" module>
  // A counter keeps label ids unique per panel (`$props.id()` needs Svelte 5.20, newer than
  // our peer range). Pass `idPrefix` for ids that match between server and client renders.
  let nextId = 0;
</script>

<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { AgentPlayback } from '@pixerate/editor/tools';
  import { createElementPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';
  import {
    isParameterGroup,
    parameterLabel,
    parameterValuesEqual,
    type ParameterField,
    type ParameterSchemaItem,
    type ParametersController,
    type ParametersState
  } from '@pixerate/editor/parameters';
  import KeyframeDiamond from './KeyframeDiamond.svelte';
  import ParameterFieldControl from './ParameterFieldControl.svelte';
  import {
    parameterButtonClass,
    parameterButtonStyle,
    parameterInputClass,
    parameterInputStyle,
    parameterSelectStyle
  } from './styles.js';
  import { resolveParameterComponents, type ParameterComponents } from './controls.js';

  interface Props {
    controller: ParametersController;
    /** Heading (default: the schema's title). Pass `null` for none. */
    title?: string | null;
    /** Undo, redo, reset and randomize buttons (default `true`). */
    showToolbar?: boolean;
    /** The preset picker with save and delete (default `true`). */
    showPresets?: boolean;
    /** Keyframe diamonds (default: when the controller has a keyframes adapter). */
    showKeyframes?: boolean;
    /** Per-field reset buttons on changed values (default `true`). */
    showFieldReset?: boolean;
    /** Turns a picked file into a URL for image fields. */
    resolveFile?: (file: File) => string | Promise<string>;
    /** Custom host components for inputs, sliders, and selects. */
    components?: ParameterComponents;
    /** Shown when the schema has no fields. */
    emptyMessage?: string;
    /** Prefix for the panel's element ids. */
    idPrefix?: string;
    class?: string;
    /** Extra content after the fields. */
    children?: Snippet;
    /**
     * Agent playback: act out `parameters.*` commands here with the agent's cursor (default:
     * `setAgentPlayback` above; `null` turns it off).
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `parameters`, where the parameter commands play). */
    playbackId?: string;
    /** Bring the panel on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }

  let {
    controller,
    title,
    showToolbar = true,
    showPresets = true,
    showKeyframes,
    showFieldReset = true,
    resolveFile,
    emptyMessage = 'No parameters.',
    idPrefix = `pixerate-parameters-${++nextId}`,
    class: className = '',
    children,
    playback,
    playbackId = 'parameters',
    onplaybackreveal,
    components
  }: Props = $props();

  const resolvedComponents = $derived(resolveParameterComponents(components));
  const CustomPresetSelect = $derived(resolvedComponents.select);

  // Agent playback: the cursor visits the controls a call changes.
  let root: HTMLDivElement | undefined = $state();
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  const agentPresence = createElementPlaybackSurface(() => playing, () => playbackId, () => root, () => ({
    defaultKind: 'parameter',
    selectors: { parameter: (id: string) => `[data-parameter-id="${CSS.escape(id)}"]` },
    reveal: onplaybackreveal
  }));

  // Follows a replaced `controller` prop too.
  let view: ParametersState = $state.raw(untrack(() => controller.getState()));
  $effect(() => {
    const current = controller;
    view = current.getState();
    return untrack(() =>
      current.subscribe((next) => {
        view = next;
      })
    );
  });

  const keys = $derived(showKeyframes ?? view.keyframesEnabled);
  const heading = $derived(title === undefined ? view.schema.title : title);

  let saving = $state(false);
  let presetName = $state('');
  let presetMessage = $state<string | null>(null);
  const activePreset = $derived(view.presets.find((p) => p.name === view.activePreset));

  function savePreset(e: SubmitEvent) {
    e.preventDefault();
    const result = controller.savePreset(presetName);
    if (result.ok) {
      saving = false;
      presetName = '';
      presetMessage = null;
    } else presetMessage = result.message;
  }
</script>

{#snippet fieldRow(field: ParameterField)}
  {@const label = parameterLabel(field)}
  {@const inputId = `${idPrefix}-${field.id}`}
  {@const error = view.errors[field.id]}
  <div data-parameter-id={field.id} data-parameter-type={field.type} class="space-y-1">
    <div class="flex min-h-[1.25rem] items-center gap-1.5">
      {#if keys}
        <KeyframeDiamond state={view.keys[field.id] ?? 'none'} {label} ontoggle={() => controller.toggleKeyframe(field.id)} />
      {/if}
      <label for={inputId} class="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={field.description}>{label}</label>
      {#if showFieldReset && !field.readOnly && !parameterValuesEqual(view.values[field.id], view.defaults[field.id])}
        <button
          type="button"
          class="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
          style={parameterButtonStyle}
          title="Reset to {String(view.defaults[field.id])}"
          aria-label="Reset {label}"
          onclick={() => controller.reset([field.id])}>↺</button
        >
      {/if}
    </div>
    {#if field.description}
      <p class="text-[11px] leading-snug text-muted-foreground">{field.description}</p>
    {/if}
    <ParameterFieldControl
      {field}
      value={view.values[field.id]}
      id={inputId}
      {resolveFile}
      {components}
      onchange={(v) => controller.setValue(field.id, v)}
      ongesturestart={() => controller.beginGesture(field.id)}
      ongestureend={() => controller.endGesture()}
    />
    {#if error}
      <p role="alert" class="text-[11px] text-destructive">{error}</p>
    {/if}
  </div>
{/snippet}

{#snippet items(list: readonly ParameterSchemaItem[])}
  {#each list as item (item.id)}
    {#if view.visible[item.id] !== false}
      {#if isParameterGroup(item)}
        {@const collapsed = !!view.collapsed[item.id]}
        <section data-parameter-group={item.id} class="rounded-md border border-border">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls="{idPrefix}-group-{item.id}"
            onclick={() => controller.toggleCollapsed(item.id)}
            class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-semibold text-foreground hover:bg-muted"
          >
            <span aria-hidden="true" class="inline-block text-[10px] text-muted-foreground transition-transform {collapsed ? '' : 'rotate-90'}"
              >▶</span
            >
            {parameterLabel(item)}
          </button>
          {#if !collapsed}
            <div id="{idPrefix}-group-{item.id}" class="space-y-3 border-t border-border px-2 py-2">
              {#if item.description}
                <p class="text-[11px] text-muted-foreground">{item.description}</p>
              {/if}
              {@render items(item.fields)}
            </div>
          {/if}
        </section>
      {:else}
        {@render fieldRow(item)}
      {/if}
    {/if}
  {/each}
{/snippet}

<!--
  Renders a whole parameter schema: collapsible groups, one control per visible field,
  keyframe diamonds, per-field reset, presets, and undo / redo / reset / randomize. Slider
  drags and colour picks are one undo step each.
-->
<div bind:this={root} class="relative space-y-3 text-foreground {className}" data-parameters-panel="">
  {#if heading || showToolbar}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if heading}
        <h3 class="mr-auto text-sm font-semibold">{heading}</h3>
      {/if}
      {#if showToolbar}
        <div class="flex flex-wrap gap-1" role="toolbar" aria-label="Parameter actions">
          <button
            type="button"
            class={parameterButtonClass}
            style={parameterButtonStyle}
            disabled={!view.canUndo}
            title={view.canUndo ? `Undo ${view.undoLabel}` : 'Nothing to undo'}
            onclick={() => controller.undo()}>Undo</button
          >
          <button
            type="button"
            class={parameterButtonClass}
            style={parameterButtonStyle}
            disabled={!view.canRedo}
            title={view.canRedo ? `Redo ${view.redoLabel}` : 'Nothing to redo'}
            onclick={() => controller.redo()}>Redo</button
          >
          <button type="button" class={parameterButtonClass} style={parameterButtonStyle} disabled={!view.modified} onclick={() => controller.reset()}>Reset</button>
          <button type="button" class={parameterButtonClass} style={parameterButtonStyle} onclick={() => controller.randomize()}>Randomize</button>
        </div>
      {/if}
    </div>
  {/if}

  {#if showPresets}
    <div class="space-y-1.5" data-parameter-presets="">
      <div class="flex items-center gap-1.5">
        {#if CustomPresetSelect}
          <CustomPresetSelect
            aria-label="Preset"
            label="Preset"
            value={view.activePreset ?? ''}
            options={[
              { value: '', label: view.presets.length ? 'Presets…' : 'No presets' },
              ...view.presets.map((p) => ({ value: p.name, label: p.name, description: p.description }))
            ]}
            class={parameterInputClass}
            style={parameterSelectStyle}
            onchange={(val) => {
              const str = String(val);
              if (str) controller.applyPreset(str);
            }}
          />
        {:else}
          <select
            aria-label="Preset"
            class={parameterInputClass}
            style={parameterSelectStyle}
            value={view.activePreset ?? ''}
            onchange={(e) => e.currentTarget.value && controller.applyPreset(e.currentTarget.value)}
          >
            <option value="" style={parameterSelectStyle}>{view.presets.length ? 'Presets…' : 'No presets'}</option>
            {#each view.presets as p (p.name)}
              <option value={p.name} title={p.description} style={parameterSelectStyle}>{p.name}</option>
            {/each}
          </select>
        {/if}
        <button type="button" class={parameterButtonClass} style={parameterButtonStyle} aria-expanded={saving} onclick={() => (saving = !saving)}>Save…</button>
        {#if activePreset && !activePreset.builtIn}
          <button
            type="button"
            class={parameterButtonClass}
            style={parameterButtonStyle}
            aria-label="Delete preset {activePreset.name}"
            onclick={() => controller.deletePreset(activePreset.name)}>Delete</button
          >
        {/if}
      </div>
      {#if saving}
        <form class="flex items-center gap-1.5" onsubmit={savePreset}>
          <!-- svelte-ignore a11y_autofocus -->
          <input autofocus aria-label="Preset name" placeholder="Preset name" class={parameterInputClass} style={parameterInputStyle} bind:value={presetName} />
          <button type="submit" class={parameterButtonClass} style={parameterButtonStyle}>Save</button>
        </form>
      {/if}
      {#if presetMessage}
        <p role="alert" class="text-[11px] text-destructive">{presetMessage}</p>
      {/if}
    </div>
  {/if}

  {#if view.fields.length === 0}
    <p class="text-xs text-muted-foreground">{emptyMessage}</p>
  {:else}
    {@render items(view.schema.fields)}
  {/if}
  {@render children?.()}
  <!-- Last, so it doesn't shift the stacked spacing. -->
  {#if playing}
    <PresenceLayer presence={agentPresence} />
  {/if}
</div>
