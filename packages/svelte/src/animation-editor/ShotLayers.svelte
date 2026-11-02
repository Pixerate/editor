<script lang="ts">
  import type { AnimationEditorController, MotionLayerSubject, MotionShotLayer, MotionShotLayerChanges, MotionShotLayerResult } from '@pixerate/editor/animation-editor';
  import { EFFECT_LAYER_ROLES, effectLayerOffered, type EffectLayerRole, type EffectSummary } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The shot whose layers to edit. */
    shot: string;
    class?: string;
  }

  let { controller, shot, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const current = $derived(editor.scene.shots.find((s) => s.id === shot));
  const layers = $derived(current?.layers ?? []);
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
  const button = 'rounded border border-border px-1 text-[11px] disabled:opacity-40';

  // The provider's layer effects, loaded when the provider changes.
  let effects = $state<EffectSummary[]>([]);
  $effect(() => {
    const provider = editor.effectsProvider;
    let live = true;
    if (!provider) {
      effects = [];
      return;
    }
    void Promise.resolve(provider.list()).then(
      (all) => live && (effects = all.filter(effectLayerOffered)),
      () => live && (effects = [])
    );
    return () => (live = false);
  });

  let open = $state<string | null>(null);
  let message = $state<string | null>(null);
  const openLayer = $derived(layers.find((l) => l.id === open));
  const description = effectDescriptionOf(() => controller.effectsProvider, () => openLayer?.effect);

  function report(r: Promise<MotionShotLayerResult>) {
    void r.then((x) => {
      message = x.ok ? null : x.error;
      if (x.ok && x.layer) open = x.layer.id;
    });
  }
  function add(value: string) {
    if (!value) return;
    if (value === ':picture') return report(controller.addShotLayer(shot, { subject: { slot: 'picture' } }));
    if (value === ':words') return report(controller.addShotLayer(shot, { subject: { text: 'Title' }, role: 'overlay' }));
    const e = effects.find((x) => x.id === value);
    report(controller.addShotLayer(shot, { effect: value, ...(e?.uses.includes('filter') ? { subject: { slot: 'picture' } } : {}) }));
  }
  function set(layer: MotionShotLayer, changes: MotionShotLayerChanges, merge?: string | null) {
    report(controller.updateShotLayer(layer.id, changes, { merge: merge ?? undefined }));
  }
  function number(layer: MotionShotLayer, raw: string, field: 'opacity' | 'fade', max: number) {
    if (raw.trim() === '') return set(layer, { [field]: null });
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= max) set(layer, { [field]: n });
  }
  function subjectKind(s: MotionLayerSubject | undefined): string {
    return !s ? '' : 'slot' in s ? 'slot' : 'text' in s ? 'text' : 'image' in s ? 'image' : 'svg';
  }
  function subjectValue(s: MotionLayerSubject | undefined): string {
    return !s ? '' : 'slot' in s ? s.slot : 'text' in s ? s.text : 'image' in s ? s.image : s.svg;
  }
  function subjectLabel(s: MotionLayerSubject | undefined): string {
    if (!s) return '';
    if ('slot' in s) return `slot ${s.slot}`;
    if ('text' in s) return `“${s.text}”`;
    return 'image' in s ? 'picture' : 'SVG';
  }
  function setKind(layer: MotionShotLayer, k: string) {
    const v = subjectValue(layer.subject);
    set(layer, { subject: k === '' ? null : k === 'slot' ? { slot: v || 'picture' } : k === 'text' ? { text: v || 'Title' } : k === 'image' ? { image: v || 'https://' } : { svg: v || '<svg xmlns="http://www.w3.org/2000/svg"/>' } });
  }
  function untilKey(layer: MotionShotLayer): string {
    return typeof layer.until === 'object' ? String(layer.until.shots) : layer.until === undefined ? '1' : 'ms';
  }
  function reset(layer: MotionShotLayer, k: string) {
    const { [k]: _gone, ...rest } = layer.values ?? {};
    set(layer, { values: Object.keys(rest).length ? rest : null, preset: null });
  }
</script>

<!--
  A shot's layers: provider effects (backgrounds, filters, overlays, titles) and bare pictures or
  words shown with the shot, bottom to top, with their role, subject, opacity, fade, length and
  controls. Add one from the provider's layer effects or as a picture or words; restack or remove
  it. Every change is one undo step (a slider drag is one).
-->
{#if current && (layers.length || effects.length || !editor.readOnly)}
  <div class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 {className}" data-shot-layers="">
    <span class="text-muted-foreground">Layers</span>
    <select class={input} aria-label="Add a layer" disabled={editor.readOnly} value="" onchange={(e) => add(e.currentTarget.value)}>
      <option value="">add a layer…</option>
      <option value=":picture">Picture</option>
      <option value=":words">Words</option>
      {#each effects as e (e.id)}
        <option value={e.id}>{e.name} ({e.uses.filter((u) => u !== 'interactive').join(', ')})</option>
      {/each}
    </select>
    {#each [...layers.keys()].reverse() as i (layers[i].id)}
      {@const layer = layers[i]}
      <button type="button" class="truncate text-left text-xs" aria-expanded={open === layer.id} onclick={() => (open = open === layer.id ? null : layer.id)} data-shot-layer={layer.id}>
        {layer.name ?? layer.effect ?? 'Picture'}
      </button>
      <div class="flex items-center gap-1">
        <span class="flex-1 truncate text-[10px] text-muted-foreground">{layer.role ?? (layer.rect ? 'subject' : 'background')} {subjectLabel(layer.subject)}</span>
        <button type="button" class={button} aria-label="Move {layer.id} up" disabled={editor.readOnly || i === layers.length - 1} onclick={() => report(controller.moveShotLayer(layer.id, i + 1))}>↑</button>
        <button type="button" class={button} aria-label="Move {layer.id} down" disabled={editor.readOnly || i === 0} onclick={() => report(controller.moveShotLayer(layer.id, i - 1))}>↓</button>
        <button type="button" class={button} aria-label="Remove {layer.id}" disabled={editor.readOnly} onclick={() => report(controller.removeShotLayer(layer.id))}>×</button>
      </div>
      {#if open === layer.id}
        <div class="col-span-2 grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1 border-l border-border pl-2" data-shot-layer-controls={layer.id}>
          <span class="text-muted-foreground">Role</span>
          <select class={input} aria-label="Layer role" disabled={editor.readOnly} value={layer.role ?? ''} onchange={(e) => set(layer, { role: (e.currentTarget.value || null) as EffectLayerRole | null })}>
            <option value="">{layer.rect ? 'subject' : 'background'} (default)</option>
            {#each EFFECT_LAYER_ROLES as r (r)}<option value={r}>{r}</option>{/each}
          </select>
          <span class="text-muted-foreground">Subject</span>
          <div class="flex gap-1">
            <select class="{input} w-20 flex-none" aria-label="Subject kind" disabled={editor.readOnly} value={subjectKind(layer.subject)} onchange={(e) => setKind(layer, e.currentTarget.value)}>
              <option value="">none</option>
              <option value="image">picture</option>
              <option value="svg">SVG</option>
              <option value="text">words</option>
              <option value="slot">slot</option>
            </select>
            {#if layer.subject}
              {@const kind = subjectKind(layer.subject)}
              <input
                class={input}
                aria-label={kind === 'image' ? 'Picture URL' : kind === 'svg' ? 'SVG markup' : kind === 'text' ? 'Words' : 'Slot name'}
                disabled={editor.readOnly}
                value={subjectValue(layer.subject)}
                onchange={(e) => e.currentTarget.value.trim() && set(layer, { subject: { [kind]: e.currentTarget.value } as MotionLayerSubject })}
              />
            {/if}
          </div>
          <span class="text-muted-foreground">Opacity</span>
          <input class={input} type="number" min="0" max="1" step="0.05" aria-label="Layer opacity" placeholder="1" disabled={editor.readOnly} value={layer.opacity ?? ''} onchange={(e) => number(layer, e.currentTarget.value, 'opacity', 1)} />
          <span class="text-muted-foreground">Fade</span>
          <input class={input} type="number" min="0" step="50" aria-label="Layer fade (ms)" placeholder="0" disabled={editor.readOnly} value={layer.fade ?? ''} onchange={(e) => number(layer, e.currentTarget.value, 'fade', 60000)} />
          <span class="text-muted-foreground">Until</span>
          <select class={input} aria-label="Layer lasts until" disabled={editor.readOnly} value={untilKey(layer)} onchange={(e) => set(layer, { until: e.currentTarget.value === '1' ? null : { shots: Number(e.currentTarget.value) } })}>
            <option value="1">the next shot</option>
            <option value="2">the shot after next</option>
            <option value="3">three shots on</option>
            {#if typeof layer.until === 'number'}<option value="ms">{layer.until} ms</option>{/if}
          </select>
          {#if description.error}
            <p class="col-span-2 text-[11px] text-amber-500">{description.error}</p>
          {:else if description.description && !editor.readOnly}
            <div class="col-span-2">
              <EffectParameters
                description={description.description}
                values={layer.values ?? {}}
                onchange={(k, v, g) => set(layer, { values: { ...(layer.values ?? {}), [k]: v as never }, preset: null }, g)}
                onreset={(k) => reset(layer, k)}
                onpresetname={(name) => set(layer, { preset: name, values: null })}
              />
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    {#if !editor.effectsProvider && layers.some((l) => l.effect)}
      <p class="col-span-2 text-[10px] text-muted-foreground">No effects provider is set, so effect layers are not drawn.</p>
    {/if}
    {#if message}<p class="col-span-2 text-[11px] text-destructive" role="alert">{message}</p>{/if}
  </div>
{/if}
