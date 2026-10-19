<script lang="ts">
  import type { FreeTransformField, FreeTransformTool, Interpolation, WarpBar } from '@pixerate/editor/image-editor';
  import { FREE_TRANSFORM_FIELDS, FREE_TRANSFORM_MODE_OPTIONS, INTERPOLATIONS, TRANSFORM_ANCHORS, WARP_GRID_OPTIONS, WARP_STYLE_OPTIONS } from '@pixerate/editor/image-editor';

  /**
   * Free Transform's options bar (Photoshop's): the mode switch (Free, Rotate, Skew, Distort,
   * Perspective, Warp), the reference-point locator, X / Y of the reference point, W / H in
   * percent with the proportional chain, the angle and skews, the interpolation, and Commit
   * (Enter) / Cancel (Esc). In Warp mode the numbers give way to the warp style, bend, horizontal
   * and vertical distortion, orientation and grid. Typed values apply on Enter or when the field
   * loses focus.
   */
  let { tool, class: className = '' }: { tool: FreeTransformTool; class?: string } = $props();

  let tick = $state(0);
  $effect(() => tool.subscribe(() => tick++));

  /** What the bar shows, re-read whenever the tool changes. */
  const view = $derived.by(() => {
    void tick;
    return { bar: tool.active ? tool.bar() : null, mode: tool.mode, proportional: tool.proportional, interpolation: tool.interpolation, error: tool.error, warp: tool.warpBar() };
  });
  const bar = $derived(view.bar);
  const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
  const round = (v: number, unit: string) => (unit === 'px' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

  const WARP_NUMBERS = [
    { key: 'bend', label: 'Bend', aria: 'Warp bend in percent' },
    { key: 'horizontal', label: 'H', aria: 'Warp horizontal distortion in percent' },
    { key: 'vertical', label: 'V', aria: 'Warp vertical distortion in percent' },
  ] as const;
  function warpNumber(key: 'bend' | 'horizontal' | 'vertical', raw: string) {
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v) && v !== tool.warpBar()[key]) tool.setWarp({ [key]: Math.max(-100, Math.min(100, v)) } as Partial<WarpBar>);
  }
  const gridId = (w: WarpBar) => WARP_GRID_OPTIONS.find((g) => g.columns === w.columns && g.rows === w.rows)?.id ?? '1x1';

  function apply(field: FreeTransformField, raw: string) {
    const b = tool.bar();
    const v = Number(raw);
    if (b && raw.trim() !== '' && Number.isFinite(v) && Math.abs(v - b[field]) > 1e-9) tool.setField(field, v);
  }
</script>

{#if bar}
  <div class="flex flex-wrap items-center gap-2 text-xs text-slate-200 {className}" data-testid="free-transform-options" role="toolbar" aria-label="Free Transform options">
    <div class="flex gap-1" role="group" aria-label="Transform mode">
      {#each FREE_TRANSFORM_MODE_OPTIONS as m (m.id)}
        <button type="button" title={m.title} aria-pressed={view.mode === m.id} class={chip(view.mode === m.id)} onclick={() => tool.setMode(m.id)}>{m.label}</button>
      {/each}
    </div>
    <div class="grid grid-cols-3 gap-px" role="group" aria-label="Reference point">
      {#each TRANSFORM_ANCHORS as a (a)}
        <button type="button" aria-label={`Reference point ${a}`} title={`Reference point: ${a}`} class="h-2.5 w-2.5 rounded-sm bg-slate-700 hover:bg-indigo-500" onclick={() => tool.setReference(a)}></button>
      {/each}
    </div>
    {#if view.mode === 'warp'}
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Warp options">
        <label class="flex items-center gap-1">
          <span class="text-slate-400">Warp</span>
          <select aria-label="Warp style" value={view.warp.style} onchange={(e) => tool.setWarp({ style: e.currentTarget.value as WarpBar['style'] })} class="rounded border border-slate-700 bg-slate-900 px-1 py-0.5">
            {#each WARP_STYLE_OPTIONS as o (o.id)}
              <option value={o.id}>{o.label}</option>
            {/each}
          </select>
        </label>
        {#each WARP_NUMBERS as n (n.key)}
          <label class="flex items-center gap-1">
            <span class="text-slate-400">{n.label}</span>
            {#key view.warp[n.key]}
              <input
                type="number"
                aria-label={n.aria}
                value={view.warp[n.key]}
                min={-100}
                max={100}
                disabled={view.warp.style === 'custom'}
                class="w-14 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-right disabled:opacity-40"
                onblur={(e) => warpNumber(n.key, e.currentTarget.value)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    warpNumber(n.key, e.currentTarget.value);
                  }
                }}
              />
            {/key}
            <span class="text-slate-500">%</span>
          </label>
        {/each}
        <button
          type="button"
          title="Bend along the vertical axis"
          aria-pressed={view.warp.orientation === 'vertical'}
          disabled={view.warp.style === 'custom'}
          class={chip(view.warp.orientation === 'vertical')}
          onclick={() => tool.setWarp({ orientation: view.warp.orientation === 'vertical' ? 'horizontal' : 'vertical' })}>Vertical</button>
        <label class="flex items-center gap-1">
          <span class="text-slate-400">Grid</span>
          <select
            aria-label="Warp grid"
            value={gridId(view.warp)}
            onchange={(e) => {
              const g = WARP_GRID_OPTIONS.find((o) => o.id === e.currentTarget.value)!;
              tool.setWarp({ columns: g.columns, rows: g.rows });
            }}
            class="rounded border border-slate-700 bg-slate-900 px-1 py-0.5"
          >
            {#each WARP_GRID_OPTIONS as g (g.id)}
              <option value={g.id}>{g.label}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}
    {#each view.mode === 'warp' ? [] : FREE_TRANSFORM_FIELDS as f (f.id)}
      <label class="flex items-center gap-1" title={f.title}>
        <span class="text-slate-400">{f.label}</span>
        {#key round(bar[f.id], f.unit)}
          <input
            type="number"
            aria-label={f.title}
            value={round(bar[f.id], f.unit)}
            disabled={!bar.affine}
            step={f.unit === 'px' ? 1 : 0.1}
            class="w-16 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-right disabled:opacity-40"
            onblur={(e) => apply(f.id, e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                apply(f.id, e.currentTarget.value);
              }
            }}
          />
        {/key}
        <span class="text-slate-500">{f.unit}</span>
        {#if f.id === 'scaleX'}
          <button
            type="button"
            aria-label="Keep width and height proportional"
            aria-pressed={view.proportional}
            class={chip(view.proportional)}
            onclick={() => {
              tool.proportional = !tool.proportional;
              tick++;
            }}>⛓︎</button>
        {/if}
      </label>
    {/each}
    <label class="flex items-center gap-1">
      <span class="text-slate-400">Interpolation</span>
      <select
        aria-label="Interpolation"
        value={view.interpolation}
        onchange={(e) => tool.setInterpolation(e.currentTarget.value as Interpolation)}
        class="rounded border border-slate-700 bg-slate-900 px-1 py-0.5"
      >
        {#each INTERPOLATIONS as i (i)}
          <option value={i}>{i[0].toUpperCase() + i.slice(1)}</option>
        {/each}
      </select>
    </label>
    <button type="button" title="Commit (Enter)" class="px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500" onclick={() => tool.commit()}>Commit</button>
    <button type="button" title="Cancel (Esc)" class={chip(false)} onclick={() => tool.cancel()}>Cancel</button>
    {#if view.error}
      <span role="alert" class="text-rose-400">{view.error}</span>
    {/if}
  </div>
{/if}
