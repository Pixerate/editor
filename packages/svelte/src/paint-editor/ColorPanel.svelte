<script lang="ts">
  import {
    HARMONY_KINDS,
    MIXING_PAD_HEIGHT,
    MIXING_PAD_WIDTH,
    PAD_SAMPLE_SIZES,
    hsvToRgb,
    padSampleRadius,
    hueToWheel,
    parseHexColor,
    renderColorWheel,
    rgbToHexColor,
    rgbToHsv,
    wheelPick,
    wheelPoint,
    type ColorWheel,
    type HarmonyKind,
    type PaintEditorController,
  } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import { DEFAULT_PAINT_GRADIENT, paintSourceCss } from '@pixerate/editor/paint-editor';
  import PaintGradientEditor from './PaintGradientEditor.svelte';
  import PixelCanvas from './PixelCanvas.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    /** Wheel diameter in px (default 168). */
    wheelSize?: number;
    /** Show the mixing pad (default true). */
    mixingPad?: boolean;
    class?: string;
  }
  let { controller, wheelSize = 168, mixingPad = true, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  let error = $state<string | null>(null);
  let wheel = $state<ColorWheel>('ryb');
  let kind = $state<HarmonyKind>('complementary');
  let padTool = $state<'paint' | 'knife' | 'pick'>('paint');
  let sample = $state(3);
  let parts = $state<[number, number]>([1, 1]);
  let padName = $state('');
  let padPoints: Array<{ x: number; y: number; pressure?: number }> | null = null;
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const ring = $derived(renderColorWheel(wheelSize, wheel));
  const color = $derived(snap.color);
  const harmony = $derived(controller.harmony(kind, { color, wheel }));
  const hsv = $derived(rgbToHsv(...parseHexColor(color)));
  const pad = $derived.by(() => {
    void snap.mixingPadVersion;
    return untrack(() => ({ width: MIXING_PAD_WIDTH, height: MIXING_PAD_HEIGHT, data: controller.mixingPad.pixels() }));
  });
  const R = $derived(wheelSize / 2);
  /** Effect paint shows as a thumbnail of the effect in the paint well. */
  const effectWell = $derived.by(() => {
    const fx = snap.effectPaint;
    const rendering = snap.effectPaintRendering;
    return fx && !rendering ? untrack(() => controller.effectPaintThumbnail(64)) : null;
  });
  const setHsv = (s: number, v: number) => controller.setColor(rgbToHexColor(...hsvToRgb(hsv.h, s, v)));
  const padPoint = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(MIXING_PAD_WIDTH, Math.max(0, (e.clientX - rect.left) * (MIXING_PAD_WIDTH / (rect.width || MIXING_PAD_WIDTH))));
    const y = Math.min(MIXING_PAD_HEIGHT, Math.max(0, (e.clientY - rect.top) * (MIXING_PAD_HEIGHT / (rect.height || MIXING_PAD_HEIGHT))));
    return e.pointerType === 'pen' && e.pressure > 0 ? { x, y, pressure: e.pressure } : { x, y };
  };
</script>

<!-- Hue wheel with harmonies, saturation and value, colours, gradient paint, harmony chips, swatches (colours and gradients), mixing pad (paint, knife, pick with a sample size, measured mixes, kept pads). -->
<div class={`${panel} ${className}`} data-testid="color-panel">
  <div class="relative self-center" style={`width: ${wheelSize}px; height: ${wheelSize}px`}>
    <div
      role="slider"
      aria-label="Hue wheel"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hueToWheel(hsv.h, wheel))}
      tabindex="0"
      class="absolute inset-0 cursor-crosshair"
      onpointerdown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        controller.setColor(wheelPick(e.clientX - rect.left - R, e.clientY - rect.top - R, wheel, color));
      }}
    >
      <PixelCanvas pixels={ring} label="Colour wheel" style={`width: ${wheelSize}px; height: ${wheelSize}px`} />
    </div>
    <svg class="pointer-events-none absolute inset-0" width={wheelSize} height={wheelSize} aria-hidden="true">
      {#each harmony as h, i (i)}
        {@const p = wheelPoint(h.angle, R * 0.82)}
        <circle cx={R + p.x} cy={R + p.y} r={i === 0 ? 7 : 5} fill={h.color} stroke="#fff" stroke-width={i === 0 ? 2 : 1} />
      {/each}
    </svg>
    <div class="absolute rounded-full border border-slate-700" style={`left: ${R - R * 0.45}px; top: ${R - R * 0.45}px; width: ${R * 0.9}px; height: ${R * 0.9}px; background: ${color}`}></div>
  </div>
  <div class="flex items-center gap-2">
    <input type="color" aria-label="Paint colour" value={color} oninput={(e) => controller.setColor(e.currentTarget.value)} class="h-7 w-9 rounded bg-transparent" />
    <input type="color" aria-label="Second colour" value={snap.secondaryColor} oninput={(e) => controller.setSecondaryColor(e.currentTarget.value)} class="h-5 w-7 rounded bg-transparent" />
    <button type="button" class={button} title="Swap colours (X)" onclick={() => controller.swapColors()}>Swap</button>
    {#key color}
      <input
        aria-label="Hex colour"
        value={color}
        onblur={(e) => {
          const v = e.currentTarget.value;
          run(() => controller.setColor(v.startsWith('#') ? v : `#${v}`));
        }}
        class="w-20 rounded bg-slate-800 px-1.5 py-0.5 font-mono"
      />
    {/key}
  </div>
  <div class="flex items-center gap-2" data-testid="paint-source">
    <span
      class="h-5 flex-1 rounded ring-1 ring-slate-700"
      aria-label={snap.effectPaint ? `Effect paint: ${snap.effectPaint.effect}` : snap.paint.type === 'gradient' ? 'Gradient paint' : 'Paint colour'}
      data-testid="paint-well"
      data-effect-paint={snap.effectPaint ? snap.effectPaint.effect : undefined}
      style:background={effectWell ? `center / cover no-repeat url("${effectWell}")` : paintSourceCss(snap.paint, { paint: color, secondary: snap.secondaryColor })}
    ></span>
    <button
      type="button"
      class={chip(snap.paint.type === 'gradient')}
      aria-pressed={snap.paint.type === 'gradient'}
      title="Paint that changes colour as the stroke goes"
      onclick={() => run(() => (snap.paint.type === 'gradient' ? controller.setColor(color) : controller.setPaint(DEFAULT_PAINT_GRADIENT)))}>Gradient</button
    >
  </div>
  {#if snap.paint.type === 'gradient'}
    <PaintGradientEditor value={snap.paint} colors={{ paint: color, secondary: snap.secondaryColor }} onchange={(g) => run(() => controller.setPaint(g))} />
  {/if}
  <label class="flex items-center gap-2">
    <span class="w-16 text-slate-400">Saturation</span>
    <input type="range" aria-label="Saturation" min="0" max="1" step="0.01" value={hsv.s} oninput={(e) => setHsv(Number(e.currentTarget.value), hsv.v)} class="flex-1 accent-indigo-500" />
  </label>
  <label class="flex items-center gap-2">
    <span class="w-16 text-slate-400">Value</span>
    <input type="range" aria-label="Value" min="0" max="1" step="0.01" value={hsv.v} oninput={(e) => setHsv(hsv.s, Number(e.currentTarget.value))} class="flex-1 accent-indigo-500" />
  </label>
  <div class="flex items-center gap-1">
    <select aria-label="Harmony" value={kind} onchange={(e) => (kind = e.currentTarget.value as HarmonyKind)} class="rounded bg-slate-800 px-1 py-0.5">
      {#each HARMONY_KINDS as k (k)}
        <option value={k}>{k}</option>
      {/each}
    </select>
    <button type="button" class={chip(wheel === 'ryb')} aria-pressed={wheel === 'ryb'} onclick={() => (wheel = 'ryb')}>RYB</button>
    <button type="button" class={chip(wheel === 'rgb')} aria-pressed={wheel === 'rgb'} onclick={() => (wheel = 'rgb')}>RGB</button>
  </div>
  <div class="flex flex-wrap gap-1" role="group" aria-label="Harmony colours">
    {#each harmony as h, i (i)}
      <button type="button" aria-label={`Use ${h.color}`} title={h.color} class="h-6 w-6 rounded ring-1 ring-slate-700" style={`background: ${h.color}`} onclick={() => controller.setColor(h.color)}></button>
    {/each}
    <button type="button" class={button} onclick={() => harmony.forEach((h) => controller.addSwatch(h.color))}>+ swatches</button>
  </div>
  <div class="flex flex-wrap gap-1" role="listbox" aria-label="Swatches">
    {#each snap.swatches as s, i (i)}
      <button
        type="button"
        role="option"
        aria-selected={s.paint ? snap.paint === s.paint : snap.paint.type === 'color' && s.color === color}
        aria-label={s.name ?? (s.paint ? 'Gradient' : s.color)}
        title={`${s.name ?? (s.paint ? 'Gradient' : s.color)} (right-click to remove)`}
        class="h-5 w-5 rounded ring-1 ring-slate-700"
        style:background={s.paint ? paintSourceCss(s.paint, { paint: color, secondary: snap.secondaryColor }) : s.color}
        onclick={() => run(() => (s.paint ? controller.setPaint(s.paint) : controller.setColor(s.color)))}
        oncontextmenu={(e) => {
          e.preventDefault();
          controller.removeSwatch(i);
        }}
      ></button>
    {/each}
    <button type="button" class={button} aria-label="Add swatch" onclick={() => run(() => controller.addSwatch(snap.paint))}>+</button>
  </div>
  {#if mixingPad}
    <div class="flex flex-col gap-1" data-testid="mixing-pad">
      <div class="flex items-center gap-1">
        <span class="text-slate-400">Mixing pad</span>
        {#each ['paint', 'knife', 'pick'] as const as t (t)}
          <button type="button" aria-pressed={padTool === t} class={chip(padTool === t)} onclick={() => (padTool = t)}>{t === 'paint' ? 'Paint' : t === 'knife' ? 'Knife' : 'Pick'}</button>
        {/each}
        <button type="button" class={button} onclick={() => controller.clearMixingPad()}>Clear</button>
      </div>
      <div
        role="application"
        aria-label="Mixing pad"
        class="touch-none cursor-crosshair"
        onpointerdown={(e) => {
          const p = padPoint(e);
          if (padTool === 'pick') {
            run(() => controller.mixingPadPick(p.x, p.y, { setColor: true, radius: padSampleRadius(sample) }));
            return;
          }
          padPoints = [p];
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onpointermove={(e) => padPoints?.push(padPoint(e))}
        onpointerup={() => {
          const pts = padPoints;
          padPoints = null;
          if (pts?.length) run(() => controller.mixingPadStroke(pts, { tool: padTool === 'knife' ? 'knife' : 'paint' }));
        }}
      >
        <PixelCanvas pixels={pad} label="Mixing pad pixels" class="w-full rounded" style={`aspect-ratio: ${MIXING_PAD_WIDTH} / ${MIXING_PAD_HEIGHT}`} />
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <label class="flex items-center gap-1">
          <span class="text-slate-400">Sample</span>
          <select aria-label="Pick sample size" value={sample} onchange={(e) => (sample = Number(e.currentTarget.value))} class="rounded bg-slate-800 px-1 py-0.5">
            {#each PAD_SAMPLE_SIZES as n (n)}
              <option value={n}>{n === 1 ? '1 px' : `${n}×${n}`}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <span class="h-4 w-4 rounded ring-1 ring-slate-700" style={`background: ${color}`}></span>
        <input type="number" aria-label="Paint colour parts" min="0" max="20" value={parts[0]} oninput={(e) => (parts = [Number(e.currentTarget.value), parts[1]])} class="w-10 rounded bg-slate-800 px-1 py-0.5" />
        <span class="text-slate-500">:</span>
        <input type="number" aria-label="Second colour parts" min="0" max="20" value={parts[1]} oninput={(e) => (parts = [parts[0], Number(e.currentTarget.value)])} class="w-10 rounded bg-slate-800 px-1 py-0.5" />
        <span class="h-4 w-4 rounded ring-1 ring-slate-700" style={`background: ${snap.secondaryColor}`}></span>
        <button
          type="button"
          class={button}
          title="Mix the paint and second colours in these parts on the pad, and use the mix"
          onclick={() =>
            run(() =>
              controller.mixOnPad(
                [
                  { color, parts: parts[0] },
                  { color: snap.secondaryColor, parts: parts[1] },
                ],
                { setColor: true }
              )
            )}>Mix</button
        >
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <input bind:value={padName} placeholder="Pad name" aria-label="Pad name" class="w-24 rounded bg-slate-800 px-1.5 py-0.5" />
        <button
          type="button"
          class={button}
          onclick={() =>
            run(() => {
              controller.saveMixingPad(padName || undefined);
              padName = '';
            })}>Keep pad</button
        >
      </div>
      {#if snap.savedMixingPads.length > 0}
        <ul class="flex flex-col gap-0.5" aria-label="Kept pads">
          {#each snap.savedMixingPads as p (p.id)}
            <li class="flex items-center gap-1">
              <button type="button" class={`${button} flex-1 text-left`} onclick={() => run(() => controller.loadMixingPad(p.id))}>{p.name}</button>
              <button type="button" class={button} aria-label={`Remove ${p.name}`} onclick={() => run(() => controller.removeMixingPad(p.id))}>×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
