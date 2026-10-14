<script lang="ts">
  import type {
    AdjustmentKind,
    AdjustmentLayer,
    BlendMode,
    ControlSpec,
    CurvePoint,
    ImageEditorController,
    ImageHistogram,
  } from '@pixerate/editor/image-editor';
  import {
    ADJUSTMENT_KINDS,
    ADJUSTMENT_LAYER_CONTROLS,
    ADJUSTMENT_LAYER_OPACITY_CONTROL,
    BLEND_MODES,
    HUE_RANGE_LABELS,
    adjustmentKindLabel,
    getControlPath,
    hueRangeWeight,
    setControlPath,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import ControlSlider from './ControlSlider.svelte';
  import CurvesEditor from './CurvesEditor.svelte';

  interface Props {
    controller: ImageEditorController;
    /** The current layers (`state.adjustments.layers`), bottom to top. Omit to follow the controller. */
    layers?: AdjustmentLayer[];
    histogram?: ImageHistogram | null;
  }

  let { controller, layers: layersProp, histogram = null }: Props = $props();

  // Follows the controller when no `layers` prop is given.
  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });
  const layers = $derived.by(() => {
    void tick;
    return layersProp ?? controller.getAdjustmentLayers();
  });

  type Channel = 'master' | 'red' | 'green' | 'blue';
  const CHANNELS: { id: Channel; label: string }[] = [
    { id: 'master', label: 'RGB' },
    { id: 'red', label: 'Red' },
    { id: 'green', label: 'Green' },
    { id: 'blue', label: 'Blue' },
  ];
  const TONES = [
    { id: 'shadows', label: 'Shadows' },
    { id: 'midtones', label: 'Midtones' },
    { id: 'highlights', label: 'Highlights' },
  ] as const;
  type Tone = (typeof TONES)[number]['id'];

  let newKind: AdjustmentKind = $state('curves');
  let selectedId: string | null = $state(null);
  let channel: Channel = $state('master');
  let range = $state(-1);
  let tone: Tone = $state('midtones');

  const selected = $derived(layers.find((l) => l.id === selectedId) ?? null);
  const topFirst = $derived([...layers].reverse());

  const selectClass = 'bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200';
  const chipClass = (on: boolean) =>
    `px-2 py-0.5 rounded text-[10px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`;

  function setParam(layer: AdjustmentLayer, path: string, value: unknown, commit = true) {
    controller.updateAdjustmentLayer(layer.id, { params: setControlPath(layer.params, path, value) as never }, commit);
  }
  const paramValue = (layer: AdjustmentLayer, spec: ControlSpec) => Number(getControlPath(layer.params, spec.id) ?? spec.default);

  function visibleControls(layer: AdjustmentLayer): ControlSpec[] {
    const all = ADJUSTMENT_LAYER_CONTROLS[layer.kind];
    switch (layer.kind) {
      case 'levels':
        return all.filter((s) => s.id.startsWith(`${channel}.`));
      case 'hueSaturation':
        return all.filter((s) =>
          range === -1 || layer.params.colorize ? !s.id.startsWith('ranges.') : s.id.startsWith(`ranges.${range}.`)
        );
      case 'colorBalance':
        return all.filter((s) => s.id.startsWith(`${tone}.`));
      default:
        return [...all];
    }
  }

  function stripPoints(bounds: [number, number, number, number]) {
    return Array.from({ length: 73 }, (_, i) => `${(i / 72) * 360},${20 - hueRangeWeight({ bounds }, i * 5) * 18}`).join(' ');
  }

  function addLayer() {
    selectedId = controller.addAdjustmentLayer(newKind);
    channel = 'master';
    range = -1;
  }
</script>

<div class="flex flex-col gap-2 text-xs" data-testid="adjustment-layers-panel">
  <div class="flex items-center justify-between">
    <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Adjustment Layers</span>
  </div>
  <div class="flex gap-1.5">
    <select aria-label="New adjustment layer kind" class="{selectClass} flex-1" bind:value={newKind}>
      {#each ADJUSTMENT_KINDS as k (k.kind)}
        <option value={k.kind}>{k.label}</option>
      {/each}
    </select>
    <button type="button" class="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500" onclick={addLayer}>
      Add Layer
    </button>
  </div>

  {#if topFirst.length > 0}
    <ul class="flex flex-col gap-1" aria-label="Adjustment layers">
      {#each topFirst as layer (layer.id)}
        {@const index = layers.indexOf(layer)}
        {@const label = layer.name || adjustmentKindLabel(layer.kind)}
        <li
          class="flex items-center gap-1.5 rounded px-1.5 py-1 {layer.id === selectedId
            ? 'bg-indigo-600/20 ring-1 ring-indigo-500/50'
            : 'bg-slate-800/60'}"
        >
          <input
            type="checkbox"
            aria-label="Show {label}"
            checked={layer.enabled}
            onchange={() => controller.toggleAdjustmentLayer(layer.id)}
            class="accent-indigo-500"
          />
          <button
            type="button"
            class="flex-1 text-left truncate {layer.enabled ? 'text-slate-200' : 'text-slate-500 line-through'}"
            aria-pressed={layer.id === selectedId}
            onclick={() => (selectedId = layer.id === selectedId ? null : layer.id)}
          >
            {label}
          </button>
          <button
            type="button"
            aria-label="Move {label} up"
            disabled={index === layers.length - 1}
            onclick={() => controller.moveAdjustmentLayer(layer.id, index + 1)}
            class="px-1 text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Move {label} down"
            disabled={index === 0}
            onclick={() => controller.moveAdjustmentLayer(layer.id, index - 1)}
            class="px-1 text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Remove {label}"
            onclick={() => {
              controller.removeAdjustmentLayer(layer.id);
              if (selectedId === layer.id) selectedId = null;
            }}
            class="px-1 text-rose-400 hover:text-rose-300"
          >
            ✕
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    {@const layer = selected}
    <div class="flex flex-col gap-2 rounded border border-slate-700/60 p-2" data-testid="adjustment-layer-editor">
      <div class="flex items-center gap-2">
        <span class="text-slate-400">Blend</span>
        <select
          aria-label="Blend mode"
          class="{selectClass} flex-1"
          value={layer.blend}
          onchange={(e) => controller.updateAdjustmentLayer(layer.id, { blend: (e.target as HTMLSelectElement).value as BlendMode })}
        >
          {#each BLEND_MODES as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </div>
      <ControlSlider
        spec={ADJUSTMENT_LAYER_OPACITY_CONTROL}
        label="Layer opacity"
        value={layer.opacity}
        onchange={(v) => controller.updateAdjustmentLayer(layer.id, { opacity: v })}
      />

      {#if layer.kind === 'curves' || layer.kind === 'levels'}
        <div class="flex gap-1" role="group" aria-label={layer.kind === 'curves' ? 'Curve channel' : 'Levels channel'}>
          {#each CHANNELS as c (c.id)}
            <button type="button" class={chipClass(channel === c.id)} onclick={() => (channel = c.id)}>{c.label}</button>
          {/each}
        </div>
      {/if}

      {#if layer.kind === 'curves'}
        <CurvesEditor
          points={layer.params[channel]}
          {channel}
          {histogram}
          onchange={(points: CurvePoint[], commit: boolean) => setParam(layer, channel, points, commit)}
        />
      {:else if layer.kind === 'hueSaturation'}
        <div class="flex flex-wrap gap-1" role="group" aria-label="Hue range">
          <button type="button" class={chipClass(range === -1)} onclick={() => (range = -1)}>Master</button>
          {#each HUE_RANGE_LABELS as name, i (name)}
            <button type="button" class={chipClass(range === i)} disabled={layer.params.colorize} onclick={() => (range = i)}>
              {name}
            </button>
          {/each}
        </div>
        {#if range >= 0 && !layer.params.colorize}
          <svg viewBox="0 0 360 20" preserveAspectRatio="none" class="w-full h-4 rounded" data-testid="hue-range-strip">
            <defs>
              <linearGradient id="pixerate-hue-strip-svelte">
                {#each [0, 60, 120, 180, 240, 300, 360] as h (h)}
                  <stop offset="{(h / 360) * 100}%" stop-color="hsl({h}, 90%, 50%)" />
                {/each}
              </linearGradient>
            </defs>
            <rect width="360" height="20" fill="url(#pixerate-hue-strip-svelte)" opacity="0.6" />
            <polyline points={stripPoints(layer.params.ranges[range].bounds)} fill="none" stroke="#fff" stroke-width="1.5" />
          </svg>
        {/if}
      {:else if layer.kind === 'colorBalance'}
        <div class="flex gap-1" role="group" aria-label="Tone">
          {#each TONES as t (t.id)}
            <button type="button" class={chipClass(tone === t.id)} onclick={() => (tone = t.id)}>{t.label}</button>
          {/each}
        </div>
      {:else if layer.kind === 'photoFilter'}
        <label class="flex items-center gap-2 text-slate-300">
          Filter colour
          <input
            type="color"
            aria-label="Filter colour"
            value={layer.params.color}
            oninput={(e) => setParam(layer, 'color', (e.target as HTMLInputElement).value)}
            class="h-5 w-8 bg-transparent"
          />
        </label>
      {:else if layer.kind === 'invert'}
        <p class="text-slate-500 text-[11px]">Invert has no settings.</p>
      {/if}

      {#each visibleControls(layer) as spec (spec.id)}
        <ControlSlider {spec} value={paramValue(layer, spec)} onchange={(v) => setParam(layer, spec.id, v)} />
      {/each}

      {#if layer.kind === 'hueSaturation' && range === -1}
        <label class="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={layer.params.colorize}
            onchange={(e) => setParam(layer, 'colorize', (e.target as HTMLInputElement).checked)}
            class="accent-indigo-500"
          />
          Colorize
        </label>
      {/if}
      {#if layer.kind === 'colorBalance' || layer.kind === 'photoFilter'}
        <label class="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={layer.params.preserveLuminosity}
            onchange={(e) => setParam(layer, 'preserveLuminosity', (e.target as HTMLInputElement).checked)}
            class="accent-indigo-500"
          />
          Preserve luminosity
        </label>
      {/if}
      {#if layer.kind === 'blackWhite'}
        <label class="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={layer.params.tint !== null}
            onchange={(e) => setParam(layer, 'tint', (e.target as HTMLInputElement).checked ? '#e1d3b3' : null)}
            class="accent-indigo-500"
          />
          Tint
          {#if layer.params.tint}
            <input
              type="color"
              aria-label="Tint colour"
              value={layer.params.tint}
              oninput={(e) => setParam(layer, 'tint', (e.target as HTMLInputElement).value)}
              class="h-5 w-8 bg-transparent"
            />
          {/if}
        </label>
      {/if}
    </div>
  {/if}
</div>
