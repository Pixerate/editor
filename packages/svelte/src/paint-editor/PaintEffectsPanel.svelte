<script lang="ts">
  import { untrack } from 'svelte';
  import { paintEffectOffered, PAPER_EFFECT_BLENDS, type PaintEditorController, type PaperEffectBlend } from '@pixerate/editor/paint-editor';
  import { pathControlsOf, type EffectUse } from '@pixerate/editor/effects';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import ImageEffectControls from '../image-editor/ImageEffectControls.svelte';
  import { attempt, button, paintEditorState, paintEffectsProvider, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const effects = paintEffectsProvider(() => controller);
  const provider = $derived(effects.current);
  const view = $derived.by(() => {
    const doc = editor.current.document;
    const activeId = doc.activeLayerId;
    return {
      activeId,
      paper: controller.getPaperEffect(),
      layerEffect: activeId ? controller.getEffectLayer(activeId) : undefined,
      pixel: activeId ? controller.getLayer(activeId)?.type === 'pixel' : false,
      effectPaint: editor.current.effectPaint,
      rendering: editor.current.effectPaintRendering,
      color: editor.current.color,
      animation: controller.getAnimation(),
      playback: editor.current.effectPlayback,
    };
  });
  /** Paints with the effect paint again with some of it changed (the other settings kept). */
  const repaint = (patch: { values?: Record<string, unknown>; map?: unknown; live?: boolean }) => {
    const fx = view.effectPaint;
    if (!fx) return;
    run(() => controller.setEffectPaint({ effect: fx.effect, values: fx.values as never, time: fx.time, map: fx.map ?? { by: 'canvas' }, live: fx.live ?? false, ...(patch as object) }));
  };
  const thumbnail = $derived.by(() => {
    const { effectPaint, rendering } = view;
    return effectPaint && !rendering ? untrack(() => controller.effectPaintThumbnail(48)) : null;
  });
  const paintLoaded = effectDescriptionOf(() => provider, () => view.effectPaint?.effect ?? null);
  const hasPathControl = $derived(Boolean(paintLoaded.description && pathControlsOf(paintLoaded.description).length > 0));
  type Browse = null | 'paper' | 'layer' | 'fill' | 'light' | 'paint';
  const BROWSERS: Record<Exclude<Browse, null>, { uses: EffectUse[]; title: string }> = {
    paper: { uses: ['generator'], title: 'Effect paper' },
    layer: { uses: ['generator', 'overlay', 'title'], title: 'Effect layer' },
    fill: { uses: ['generator', 'overlay', 'title'], title: 'Fill the layer' },
    light: { uses: ['filter'], title: 'Light on the paint' },
    paint: { uses: ['generator', 'overlay', 'title'], title: 'Paint with an effect' },
  };
  let browse = $state<Browse>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  const run = (work: () => unknown) =>
    attempt(() => {
      busy = true;
      return Promise.resolve().then(work).finally(() => (busy = false));
    }, (m) => (error = m));
  const drags = new Set<string>();
  /** The first change of a drag records the undo step; later ones join it. */
  function commit(gesture: string | null) {
    if (!gesture) return true;
    if (drags.has(gesture)) return false;
    drags.add(gesture);
    return true;
  }
  function toggle(b: Exclude<Browse, null>) {
    browse = browse === b ? null : b;
  }
  function pick(id: string) {
    const kind = browse;
    const layerId = view.activeId;
    browse = null;
    if (kind === 'paper') run(() => controller.setPaperEffect(id));
    else if (kind === 'layer') run(() => controller.addEffectLayer(id));
    else if (kind === 'fill') run(() => controller.fillLayerWithEffect(id));
    else if (kind === 'light' && layerId) run(() => controller.applyLightEffect(layerId, id));
    else if (kind === 'paint') run(() => controller.setEffectPaint({ effect: id }));
  }
</script>

<!--
  Provider effects in the paint editor: effect paper (a generator over the sheet, multiplied so the
  grain shows), effect layers, effect fills, light baked onto the active layer's dried paint and
  effect paint (brushes take their colours from the effect); plus the controls of the effect
  paper, of an active effect layer and of the effect paint. Each change is one undo
  step (a slider drag is one). Without a provider it says why nothing can be added.
-->
<div class={`${panel} ${className}`} data-testid="paint-effects-panel" aria-busy={busy}>
  <div class="flex flex-wrap items-center gap-1">
    <span class="flex-1 font-medium text-slate-300">Effects</span>
    <button type="button" class={button} disabled={!provider} aria-pressed={browse === 'paper'} onclick={() => toggle('paper')}>Paper…</button>
    <button type="button" class={button} disabled={!provider} aria-pressed={browse === 'layer'} onclick={() => toggle('layer')}>Layer…</button>
    <button type="button" class={button} disabled={!provider || !view.pixel} aria-pressed={browse === 'fill'} onclick={() => toggle('fill')}>Fill…</button>
    <button type="button" class={button} disabled={!provider || !view.pixel} aria-pressed={browse === 'light'} onclick={() => toggle('light')} title="Bake a light, glow or grade into the active layer's dried paint">Light…</button>
    <button type="button" class={button} disabled={!provider} aria-pressed={browse === 'paint'} onclick={() => toggle('paint')} title="Paint with an effect: brushes take each pixel's colour from it">Paint…</button>
  </div>
  {#if !provider}<p class="text-[11px] text-slate-400">No effects provider is registered. Effects in the painting are kept.</p>{/if}
  {#if browse}
    <EffectsBrowser {provider} uses={BROWSERS[browse].uses} filter={(e) => paintEffectOffered(e, browse!, provider?.capabilities)} title={BROWSERS[browse].title} onpick={(e) => pick(e.id)} />
  {/if}
  {#if view.paper}
    {@const paper = view.paper}
    <div class="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="paper">
      <div class="flex items-center gap-1">
        <span class="flex-1 truncate">Paper: {paper.name ?? paper.effect}</span>
        <button type="button" class={button} aria-label="Remove the effect paper" onclick={() => run(() => controller.setPaperEffect(null))}>✕</button>
      </div>
      <label class="flex items-center gap-1">
        <span class="w-14 text-[11px] text-slate-400">Opacity</span>
        <input type="range" min="0" max="1" step="0.01" class="flex-1" aria-label="Effect paper opacity" value={paper.opacity} onchange={(e) => { const opacity = Number(e.currentTarget.value); run(() => controller.updatePaperEffect({ opacity })); }} />
      </label>
      <label class="flex items-center gap-1">
        <span class="w-14 text-[11px] text-slate-400">Blend</span>
        <select class="flex-1 rounded bg-slate-800 px-1 py-0.5 text-[11px]" aria-label="Effect paper blend" value={paper.blend} onchange={(e) => { const blend = e.currentTarget.value as PaperEffectBlend; run(() => controller.updatePaperEffect({ blend })); }}>
          {#each PAPER_EFFECT_BLENDS as b (b)}<option value={b}>{b}</option>{/each}
        </select>
      </label>
      <ImageEffectControls
        {provider}
        effect={paper.effect}
        name={paper.name}
        values={paper.values}
        onchange={(k, v, gesture) => run(() => controller.updatePaperEffect({ values: { [k]: v as never } }, commit(gesture)))}
        onpreset={(values) => run(() => controller.updatePaperEffect({ values: { ...values } as never }))}
      />
    </div>
  {/if}
  {#if view.effectPaint}
    {@const fx = view.effectPaint}
    <div class="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="paint">
      <div class="flex items-center gap-1">
        {#if thumbnail}<img src={thumbnail} alt="" class="h-5 w-8 rounded object-cover ring-1 ring-slate-700" data-testid="effect-paint-thumbnail" />{/if}
        <span class="flex-1 truncate">Paint: {fx.effect}{view.rendering ? ' (rendering…)' : ''}</span>
        <button type="button" class={button} aria-label="Stop painting with the effect" onclick={() => run(() => controller.setColor(view.color))}>✕</button>
      </div>
      <ImageEffectControls
        {provider}
        effect={fx.effect}
        values={fx.values}
        onchange={(k, v) => repaint({ values: { ...fx.values, [k]: v } })}
        onpreset={(values) => repaint({ values: { ...fx.values, ...values } })}
      />
      <div class="flex flex-wrap items-center gap-2" data-testid="effect-paint-placement">
        <label class="flex items-center gap-1" title="Lay the effect along each stroke instead of fixing it to the canvas">
          <input type="checkbox" checked={fx.map?.by === 'stroke'} onchange={(e) => repaint({ map: e.currentTarget.checked ? { by: 'stroke', length: 300, repeat: 'repeat' } : { by: 'canvas' } })} />
          Along the stroke
        </label>
        {#if hasPathControl}
          <label class="flex items-center gap-1" title="Pass each stroke's centreline to the effect's own path control">
            <input type="checkbox" checked={fx.map?.by === 'path'} onchange={(e) => repaint({ map: e.currentTarget.checked ? { by: 'path' } : { by: 'canvas' } })} />
            Along the stroke (native)
          </label>
        {/if}
        <label class="flex items-center gap-1" title="Strokes on a stroke layer keep playing the effect">
          <input type="checkbox" checked={Boolean(fx.live)} onchange={(e) => repaint({ live: e.currentTarget.checked })} />
          Live
        </label>
      </div>
      {#if fx.map?.by === 'stroke'}
        {@const map = fx.map}
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-1">
            <span class="text-slate-400">Length</span>
            <input type="number" aria-label="Effect length along the stroke" min="16" max="4096" value={map.length} onchange={(e) => { const length = Number(e.currentTarget.value); if (length !== map.length) repaint({ map: { ...map, length } }); }} class="w-16 rounded bg-slate-800 px-1 py-0.5" />
          </label>
          <select aria-label="Effect repeat" value={map.repeat} onchange={(e) => repaint({ map: { ...map, repeat: e.currentTarget.value } })} class="rounded bg-slate-800 px-1 py-0.5">
            <option value="repeat">Repeat</option>
            <option value="mirror">Mirror</option>
            <option value="clamp">Clamp</option>
          </select>
        </div>
      {/if}
    </div>
  {/if}
  {#if view.animation}
    {@const animation = view.animation}
    <div class="flex items-center gap-2 rounded border border-slate-700 p-1" data-effect-part="playback">
      <span class="flex-1 truncate">Live paint: {animation.strokes} {animation.strokes === 1 ? 'stroke' : 'strokes'}</span>
      <button type="button" class={button} aria-pressed={view.playback.playing} onclick={() => attempt(() => controller.setEffectPlayback({ playing: !view.playback.playing }), (m) => (error = m))}>{view.playback.playing ? 'Pause' : 'Play'}</button>
      <label class="flex items-center gap-1">
        <span class="text-slate-400">fps</span>
        <input type="number" aria-label="Live paint frame rate" min="1" max="60" value={view.playback.fps} onchange={(e) => attempt(() => controller.setEffectPlayback({ fps: Math.round(Number(e.currentTarget.value)) }), (m) => (error = m))} class="w-12 rounded bg-slate-800 px-1 py-0.5" />
      </label>
    </div>
  {/if}
  {#if view.layerEffect && view.activeId}
    {@const fx = view.layerEffect}
    {@const layerId = view.activeId}
    <div class="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="layer">
      <div class="flex items-center gap-1">
        <span class="flex-1 truncate">Layer: {fx.name ?? fx.effect}</span>
        <button type="button" class={button} title="Keep the pixels as a plain layer" onclick={() => run(() => controller.rasterizeEffectLayer(layerId))}>Rasterize</button>
      </div>
      <ImageEffectControls
        {provider}
        effect={fx.effect}
        name={fx.name}
        values={fx.values}
        onchange={(k, v, gesture) => run(() => controller.updateEffectLayer(layerId, { values: { [k]: v as never } }, commit(gesture)))}
        onpreset={(values) => run(() => controller.updateEffectLayer(layerId, { values: { ...values } as never }))}
      />
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
