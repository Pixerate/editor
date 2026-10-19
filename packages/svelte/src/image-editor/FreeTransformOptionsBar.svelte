<script lang="ts">
  import type { FreeTransformField, FreeTransformTool, Interpolation } from '@pixerate/editor/image-editor';
  import { FREE_TRANSFORM_FIELDS, FREE_TRANSFORM_MODE_OPTIONS, INTERPOLATIONS, TRANSFORM_ANCHORS } from '@pixerate/editor/image-editor';

  /**
   * Free Transform's options bar (Photoshop's): the mode switch (Free, Rotate, Skew, Distort,
   * Perspective), the reference-point locator, X / Y of the reference point, W / H in percent
   * with the proportional chain, the angle and skews, the interpolation, and Commit (Enter) /
   * Cancel (Esc). Typed values apply on Enter or when the field loses focus.
   */
  let { tool, class: className = '' }: { tool: FreeTransformTool; class?: string } = $props();

  let tick = $state(0);
  $effect(() => tool.subscribe(() => tick++));

  /** What the bar shows, re-read whenever the tool changes. */
  const view = $derived.by(() => {
    void tick;
    return { bar: tool.active ? tool.bar() : null, mode: tool.mode, proportional: tool.proportional, interpolation: tool.interpolation, error: tool.error };
  });
  const bar = $derived(view.bar);
  const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
  const round = (v: number, unit: string) => (unit === 'px' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

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
    {#each FREE_TRANSFORM_FIELDS as f (f.id)}
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
