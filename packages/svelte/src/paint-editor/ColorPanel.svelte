<script lang="ts">
  import {
    HARMONY_KINDS,
    MIXING_PAD_HEIGHT,
    MIXING_PAD_WIDTH,
    hsvToRgb,
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
  const setHsv = (s: number, v: number) => controller.setColor(rgbToHexColor(...hsvToRgb(hsv.h, s, v)));
  const padPoint = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(MIXING_PAD_WIDTH, Math.max(0, (e.clientX - rect.left) * (MIXING_PAD_WIDTH / (rect.width || MIXING_PAD_WIDTH))));
    const y = Math.min(MIXING_PAD_HEIGHT, Math.max(0, (e.clientY - rect.top) * (MIXING_PAD_HEIGHT / (rect.height || MIXING_PAD_HEIGHT))));
    return e.pointerType === 'pen' && e.pressure > 0 ? { x, y, pressure: e.pressure } : { x, y };
  };
</script>

<!-- Hue wheel with harmonies, saturation and value, colours, harmony chips, swatches, mixing pad. -->
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
        aria-selected={s.color === color}
        aria-label={s.name ?? s.color}
        title={`${s.name ?? s.color} (right-click to remove)`}
        class="h-5 w-5 rounded ring-1 ring-slate-700"
        style={`background: ${s.color}`}
        onclick={() => controller.setColor(s.color)}
        oncontextmenu={(e) => {
          e.preventDefault();
          controller.removeSwatch(i);
        }}
      ></button>
    {/each}
    <button type="button" class={button} aria-label="Add swatch" onclick={() => controller.addSwatch(color)}>+</button>
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
            run(() => controller.mixingPadPick(p.x, p.y, { setColor: true }));
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
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
