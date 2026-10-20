<script lang="ts">
  import type { Gradient as PaintGradientSource, GradientKit as PaintGradientKit, GradientMappingKind as PaintGradientMappingKind, GradientRepeat as PaintGradientRepeat, GradientSpace as PaintGradientSpace, GradientStop as PaintGradientStop } from './paintGradientTypes.js';

  interface Props {
    value: PaintGradientSource;
    onchange: (paint: PaintGradientSource) => void;
    /** What `paint` / `secondary` stops show as (the editor's two colours). */
    colors: { paint: string; secondary: string };
    class?: string;
    /** The gradient helpers (`PAINT_GRADIENT_KIT`, from the editor's own entry). */
    kit: PaintGradientKit;
  }
  let { value, onchange, colors, class: className = '', kit }: Props = $props();
  // The kit is a constant module object: reading it once is right.
  // svelte-ignore state_referenced_locally
  const {
    PAINT_GRADIENT_MAPPINGS,
    PAINT_GRADIENT_MAPPING_LABELS,
    PAINT_GRADIENT_PRESETS,
    PAINT_GRADIENT_REPEATS,
    PAINT_GRADIENT_REPEAT_LABELS,
    PAINT_GRADIENT_SPACES,
    PAINT_GRADIENT_SPACE_LABELS,
    addPaintGradientStop,
    paintGradientMappingFor,
    paintSourceCss,
    removePaintGradientStop,
    reversePaintGradient,
    updatePaintGradientStop,
  } = kit;
  let selected = $state(0);
  const sel = $derived(Math.min(selected, value.stops.length - 1));
  const stop = $derived(value.stops[sel]);
  const map = $derived(value.map);
  const button = 'px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40';
  const select = 'rounded bg-slate-800 px-1 py-0.5 text-[11px]';
  const number = 'w-16 rounded bg-slate-800 px-1 py-0.5 text-[11px]';
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const stopHex = (c: string) => (c === 'paint' ? colors.paint : c === 'secondary' ? colors.secondary : c);
  const own = (c: string) => c !== 'paint' && c !== 'secondary';
  const patchStop = (patch: Partial<PaintGradientStop>) => {
    const r = updatePaintGradientStop(value, sel, patch);
    selected = r.index;
    onchange(r.paint);
  };
  const setMap = (m: Record<string, unknown>) => onchange({ ...value, map: { ...map, ...m } as PaintGradientSource['map'] });
  const addAt = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const r = addPaintGradientStop(value, rect.width ? (e.clientX - rect.left) / rect.width : 0.5, colors);
    if (r.index >= 0) {
      selected = r.index;
      onchange(r.paint);
    }
  };
</script>

<!-- Gradient paint editor (the vector editor's stop ramp, for paint): stops (colour or the paint / second colour, opacity, position, midpoint), mixing space, what moves the stroke along it, softness, reverse and presets. -->
<div class={`flex flex-col gap-1.5 text-xs text-slate-200 ${className}`} data-testid="paint-gradient-editor" aria-label="Gradient paint">
  <div class="flex items-center gap-1">
    <select
      aria-label="Gradient preset"
      class={select}
      value=""
      onchange={(e) => {
        const v = e.currentTarget.value;
        if (v) {
          selected = 0;
          onchange(PAINT_GRADIENT_PRESETS[Number(v)].paint);
        }
      }}
    >
      <option value="">Presets…</option>
      {#each PAINT_GRADIENT_PRESETS as p, i (p.name)}<option value={i}>{p.name}</option>{/each}
    </select>
    <button type="button" class={button} onclick={() => onchange(reversePaintGradient(value))}>Reverse</button>
  </div>
  <div
    role="slider"
    tabindex="0"
    aria-label="Gradient ramp: click to add a stop"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={pct(stop.offset)}
    data-testid="paint-gradient-ramp"
    class="relative h-6 cursor-copy rounded ring-1 ring-slate-700"
    style:background={paintSourceCss(value, colors)}
    onclick={addAt}
    onkeydown={() => {}}
  ></div>
  <div class="relative h-4" aria-label="Stops">
    {#each value.stops as s, i (i)}
      <button
        type="button"
        aria-label={`Stop ${i + 1} at ${pct(s.offset)}%`}
        aria-pressed={i === sel}
        class={`absolute top-0 h-4 w-3 -translate-x-1/2 rounded-sm ring-1 ${i === sel ? 'ring-white' : 'ring-slate-600'}`}
        style:left={`${s.offset * 100}%`}
        style:background={stopHex(s.color)}
        onclick={() => (selected = i)}
      ></button>
    {/each}
  </div>
  <div class="flex flex-wrap items-center gap-1" data-testid="paint-gradient-stop">
    <select aria-label="Stop colour source" class={select} value={own(stop.color) ? 'color' : stop.color} onchange={(e) => patchStop({ color: e.currentTarget.value === 'color' ? stopHex(stop.color) : e.currentTarget.value })}>
      <option value="color">Colour</option>
      <option value="paint">Paint colour</option>
      <option value="secondary">Second colour</option>
    </select>
    {#if own(stop.color)}
      <input type="color" aria-label="Stop colour" value={stop.color} oninput={(e) => patchStop({ color: e.currentTarget.value })} class="h-6 w-8 rounded bg-transparent" />
    {/if}
    <label class="flex items-center gap-1">At <input type="number" aria-label="Stop position" min="0" max="100" step="1" value={pct(stop.offset)} oninput={(e) => patchStop({ offset: Number(e.currentTarget.value) / 100 })} class={number} />%</label>
    <label class="flex items-center gap-1">Opacity <input type="number" aria-label="Stop opacity" min="0" max="100" step="5" value={pct(stop.opacity ?? 1)} oninput={(e) => patchStop({ opacity: Number(e.currentTarget.value) / 100 })} class={number} />%</label>
    {#if sel < value.stops.length - 1}
      <label class="flex items-center gap-1">Midpoint <input type="number" aria-label="Stop midpoint" min="5" max="95" step="1" value={pct(stop.midpoint ?? 0.5)} oninput={(e) => patchStop({ midpoint: Number(e.currentTarget.value) / 100 })} class={number} />%</label>
    {/if}
    <button
      type="button"
      class={button}
      disabled={value.stops.length <= 2}
      onclick={() => {
        const at = sel;
        selected = Math.max(0, at - 1);
        onchange(removePaintGradientStop(value, at));
      }}>Remove stop</button
    >
  </div>
  <div class="flex flex-wrap items-center gap-1" data-testid="paint-gradient-mapping">
    <select aria-label="Gradient follows" class={select} value={map.by} onchange={(e) => onchange({ ...value, map: paintGradientMappingFor(e.currentTarget.value as PaintGradientMappingKind, map) })}>
      {#each PAINT_GRADIENT_MAPPINGS as m (m)}<option value={m}>{PAINT_GRADIENT_MAPPING_LABELS[m]}</option>{/each}
    </select>
    {#if map.by === 'distance'}
      <input type="number" aria-label="Gradient length" min="1" max="100000" value={map.length} oninput={(e) => setMap({ length: Math.max(1, Number(e.currentTarget.value) || 1) })} class={number} />
      <select aria-label="Gradient length unit" class={select} value={map.unit ?? 'px'} onchange={(e) => setMap({ unit: e.currentTarget.value })}>
        <option value="px">px</option>
        <option value="dabs">dabs</option>
      </select>
    {/if}
    {#if map.by === 'time'}
      <input type="number" aria-label="Gradient duration" min="1" max="600000" value={map.duration} oninput={(e) => setMap({ duration: Math.max(1, Number(e.currentTarget.value) || 1) })} class={number} />
    {/if}
    {#if map.by === 'random'}
      <input type="number" aria-label="Dabs per pick" min="1" max="500" value={map.every ?? 1} oninput={(e) => setMap({ every: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) })} class={number} />
    {/if}
    {#if map.by === 'distance' || map.by === 'time'}
      <select aria-label="Gradient repeat" class={select} value={map.repeat ?? 'clamp'} onchange={(e) => setMap({ repeat: e.currentTarget.value as PaintGradientRepeat })}>
        {#each PAINT_GRADIENT_REPEATS as r (r)}<option value={r}>{PAINT_GRADIENT_REPEAT_LABELS[r]}</option>{/each}
      </select>
    {/if}
  </div>
  <div class="flex items-center gap-1">
    <select aria-label="Gradient mixing" class={select} value={value.space} onchange={(e) => onchange({ ...value, space: e.currentTarget.value as PaintGradientSpace })}>
      {#each PAINT_GRADIENT_SPACES as s (s)}<option value={s}>{PAINT_GRADIENT_SPACE_LABELS[s]}</option>{/each}
    </select>
    <label class="flex flex-1 items-center gap-1">Softness <input type="range" aria-label="Gradient softness" min="0" max="1" step="0.05" value={value.softness ?? 1} oninput={(e) => onchange({ ...value, softness: Number(e.currentTarget.value) })} class="flex-1 accent-indigo-500" /></label>
  </div>
</div>
