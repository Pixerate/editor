<script lang="ts">
  import {
    VECTOR_EFFECT_MENU,
    getVectorEffectsPanel,
    type VectorEditorController,
    type VectorEffectsPanelItem,
    type VectorEffectType
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * The live path effects of the selection: add effects (to every selected node), and for one
   * selected node list its stack (applied top to bottom) to turn on and off, reorder, remove and
   * edit. Slider drags and typing are one undo step each. Expand Appearance bakes the effects and
   * live booleans into plain paths.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorEffectsPanel(view));

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  /** Parameter names sit on their own line in a narrow panel, the controls below. */
  const labelClass = 'w-full truncate text-[11px] text-muted-foreground';

  const end = () => controller.endMergedEdit();
  function set(e: VectorEffectsPanelItem, key: string, value: unknown, merge: boolean) {
    if (panel?.nodeId) controller.updateEffect(panel.nodeId, e.id, { params: { [key]: value } }, { merge });
  }
  function setNumber(e: VectorEffectsPanelItem, key: string, raw: string) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) set(e, key, n, true);
  }
  function setAxis(e: VectorEffectsPanelItem, key: string, axis: 'x' | 'y', raw: string) {
    const n = parseFloat(raw);
    const v = vecOf(e, key);
    if (Number.isFinite(n)) set(e, key, { ...v, [axis]: n }, true);
  }
  const vecOf = (e: VectorEffectsPanelItem, key: string) => (e.params[key] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
  const round = (n: number) => Math.round(n * 1000) / 1000;
</script>

{#if panel}
  <div class="space-y-2 {className}" data-vector-effects="" aria-label="Effects">
    <div class="flex items-center gap-2">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Effects</span>
      <select
        aria-label="Add effect"
        class={selectClass}
        value=""
        onchange={(ev) => {
          const type = ev.currentTarget.value;
          ev.currentTarget.value = '';
          if (type) controller.addEffect(type as VectorEffectType);
        }}
      >
        <option value="">Add effect…</option>
        {#each VECTOR_EFFECT_MENU as m (m.type)}<option value={m.type}>{m.label}</option>{/each}
      </select>
      <button type="button" class={buttonClass} title="Expand Appearance" aria-label="Expand Appearance" disabled={!panel.expandable} onclick={() => controller.expandAppearance()}>
        Expand
      </button>
    </div>
    {#if panel.count > 1}<p class="text-[11px] text-muted-foreground">Select one object to edit its effects.</p>{/if}
    {#if panel.nodeId}
      {@const nodeId = panel.nodeId}
      {#each panel.effects as e, i (e.id)}
        <div class="space-y-1 rounded border border-border p-1.5" data-vector-effect={e.id} data-vector-effect-type={e.type}>
          <div class="flex items-center gap-1">
            <label class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-foreground">
              <input type="checkbox" aria-label="{e.label} on" checked={e.enabled} onchange={(ev) => controller.updateEffect(nodeId, e.id, { enabled: ev.currentTarget.checked })} />
              <span class="truncate">{e.label}</span>
            </label>
            <button type="button" class={buttonClass} title="Move up" aria-label="Move {e.label} up" disabled={i === 0} onclick={() => controller.moveEffect(nodeId, e.id, i - 1)}>↑</button>
            <button
              type="button"
              class={buttonClass}
              title="Move down"
              aria-label="Move {e.label} down"
              disabled={i === panel.effects.length - 1}
              onclick={() => controller.moveEffect(nodeId, e.id, i + 1)}>↓</button
            >
            <button type="button" class={buttonClass} title="Remove" aria-label="Remove {e.label}" onclick={() => controller.removeEffect(nodeId, e.id)}>×</button>
          </div>
          {#each e.specs as spec (spec.key)}
            {#if spec.kind === 'number'}
              {@const value = Number(e.params[spec.key] ?? 0)}
              <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
                <span class={labelClass}>{spec.label}</span>
                {#if spec.slider}
                  <input
                    type="range"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    aria-label="{e.label} {spec.label} slider"
                    class="h-4 min-w-0 flex-1 accent-primary"
                    {value}
                    oninput={(ev) => setNumber(e, spec.key, ev.currentTarget.value)}
                    onpointerup={end}
                    onkeyup={end}
                    onblur={end}
                  />
                {/if}
                <input
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  aria-label="{e.label} {spec.label}"
                  class={numberClass}
                  value={round(value)}
                  oninput={(ev) => setNumber(e, spec.key, ev.currentTarget.value)}
                  onblur={end}
                />
              </label>
            {:else if spec.kind === 'vec2'}
              {@const v = vecOf(e, spec.key)}
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
                <span class={labelClass}>{spec.label}</span>
                {#each ['x', 'y'] as const as axis (axis)}
                  <input
                    type="number"
                    step={spec.step}
                    aria-label="{e.label} {spec.label} {axis}"
                    class={numberClass}
                    value={round(v[axis])}
                    oninput={(ev) => setAxis(e, spec.key, axis, ev.currentTarget.value)}
                    onblur={end}
                  />
                {/each}
              </div>
            {:else if spec.kind === 'boolean'}
              <label class="flex items-center gap-2 text-xs text-foreground" data-vector-effect-param={spec.key}>
                <span class="min-w-0 flex-1 truncate">{spec.label}</span>
                <input type="checkbox" aria-label="{e.label} {spec.label}" checked={!!e.params[spec.key]} onchange={(ev) => set(e, spec.key, ev.currentTarget.checked, false)} />
              </label>
            {:else}
              <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
                <span class={labelClass}>{spec.label}</span>
                <select aria-label="{e.label} {spec.label}" class={selectClass} value={String(e.params[spec.key] ?? '')} onchange={(ev) => set(e, spec.key, ev.currentTarget.value, false)}>
                  {#each spec.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              </label>
            {/if}
          {/each}
        </div>
      {/each}
    {/if}
  </div>
{/if}
