<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import {
    type ColorPickerState,
    contrastRatio,
    formatHex,
    inSrgbGamut,
    parseColor,
    pickerAlphaBackground,
    pickerAreaBackground,
    pickerKeyStep,
    pickerStateFromAlpha,
    pickerStateFromArea,
    pickerStateFromColor,
    pickerStateFromHue,
    pickerStateToHex,
    pushRecentColor,
    PICKER_HUE_BACKGROUND
  } from '@pixerate/editor/color';

  interface Props {
    /** The current colour value (any valid CSS colour string or hex). */
    value: string;
    /** Called when the colour value changes. */
    onchange?: (value: string) => void;
    onChange?: (value: string) => void;
    /** Called when a continuous pointer drag or keyboard interaction starts. */
    ongesturestart?: () => void;
    onGestureStart?: () => void;
    /** Called when a continuous pointer drag or keyboard interaction ends. */
    ongestureend?: () => void;
    onGestureEnd?: () => void;
    /** Whether the alpha channel slider is shown and alpha hex values emitted. Default: false. */
    alpha?: boolean;
    /** Palette swatches shown beneath the sliders. */
    swatches?: readonly string[];
    /** Controlled recent colours. If omitted, internal recents persisted in localStorage are used. */
    recent?: readonly string[];
    /** Called when the list of recent colours changes. */
    onrecentchange?: (recent: readonly string[]) => void;
    onRecentChange?: (recent: readonly string[]) => void;
    /** If provided, renders live WCAG contrast ratio badges against this background colour. */
    contrastAgainst?: string;
    /** Whether the picker is disabled. */
    disabled?: boolean;
    /** Additional CSS class names for the outer container. */
    class?: string;
    className?: string;
    /** Optional DOM id for the container. */
    id?: string;
    /** Accessible label for the colour picker group. */
    'aria-label'?: string;
  }

  let {
    value,
    onchange,
    onChange,
    ongesturestart,
    onGestureStart,
    ongestureend,
    onGestureEnd,
    alpha = false,
    swatches,
    recent,
    onrecentchange,
    onRecentChange,
    contrastAgainst,
    disabled = false,
    class: classProp,
    className,
    id,
    'aria-label': ariaLabel = 'Color picker'
  }: Props = $props();

  const LOCAL_STORAGE_KEY = 'pixerate:color:recent';

  function readLocalRecents(): string[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLocalRecents(list: readonly string[]): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
      }
    } catch {}
  }

  /** Transparency checkerboard; themeable through `--pixerate-checker-a` / `--pixerate-checker-b`. */
  const CHECKERBOARD_BG =
    'repeating-conic-gradient(var(--pixerate-checker-a, #d4d4d8) 0 25%, var(--pixerate-checker-b, #ffffff) 0 50%)';

  const DEFAULT_STATE: ColorPickerState = { h: 0, s: 1, v: 1, alpha: 1 };

  let pickerState = $state<ColorPickerState>(
    untrack(() => pickerStateFromColor(value)) ?? DEFAULT_STATE
  );

  // Synchronise pickerState when external value changes
  $effect(() => {
    const prev = untrack(() => pickerState);
    const next = pickerStateFromColor(value, prev);
    if (next) {
      pickerState = next;
    }
  });

  // Callbacks dispatcher
  function emitChange(nextVal: string) {
    onchange?.(nextVal);
    onChange?.(nextVal);
  }

  function emitGestureStart() {
    ongesturestart?.();
    onGestureStart?.();
  }

  function emitGestureEnd() {
    ongestureend?.();
    onGestureEnd?.();
  }

  function emitRecentChange(recents: readonly string[]) {
    onrecentchange?.(recents);
    onRecentChange?.(recents);
  }

  // Recents management
  let internalRecent = $state<string[]>(readLocalRecents());
  const activeRecent = $derived(recent ?? internalRecent);

  function recordRecent(color: string) {
    const updated = pushRecentColor(activeRecent, color, 12);
    if (!recent) {
      internalRecent = updated;
      writeLocalRecents(updated);
    }
    emitRecentChange(updated);
  }

  // Derived styling & formatting
  const currentHex = $derived(pickerStateToHex(pickerState, alpha));
  const areaBg = $derived(pickerAreaBackground(pickerState));
  const alphaBg = $derived(pickerAlphaBackground(pickerState));

  // Contrast derived
  const contrastResult = $derived.by(() => {
    if (!contrastAgainst) return null;
    const fg = parseColor(value);
    const bg = parseColor(contrastAgainst);
    if (!fg || !bg) return null;
    const ratio = contrastRatio(fg, bg);
    return {
      ratio,
      aa: ratio >= 4.5,
      aaa: ratio >= 7
    };
  });

  const liveDescription = $derived(
    `Selected color: ${value}${
      contrastResult
        ? `, contrast ${contrastResult.ratio.toFixed(1)}:1 against ${contrastAgainst}, ${
            contrastResult.aa ? 'passes AA' : 'fails AA'
          }`
        : ''
    }`
  );

  // Text draft state
  let textDraft = $state(untrack(() => value));
  let isInvalid = $state(false);
  let isClipped = $state(false);
  let isTyping = false;

  $effect(() => {
    if (!isTyping) {
      textDraft = value;
      isInvalid = false;
      const parsed = parseColor(value);
      isClipped = Boolean(parsed && !inSrgbGamut(parsed));
    }
  });

  function commitTextInput(target?: HTMLInputElement) {
    isTyping = false;
    const parsed = parseColor(textDraft);
    if (parsed) {
      isInvalid = false;
      isClipped = !inSrgbGamut(parsed);
      const formatted = formatHex(parsed);
      emitChange(formatted);
      recordRecent(formatted);
    } else {
      isInvalid = true;
      textDraft = value;
      if (target) {
        target.value = value;
      }
    }
  }

  // EyeDropper API check
  let hasEyeDropper = $state(false);
  $effect(() => {
    hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;
  });

  async function handleEyeDropper() {
    if (disabled || !hasEyeDropper) return;
    try {
      const EyeDropperClass = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const eyeDropper = new EyeDropperClass();
      const res = await eyeDropper.open();
      if (res?.sRGBHex) {
        emitChange(res.sRGBHex);
        recordRecent(res.sRGBHex);
      }
    } catch {
      // User cancelled
    }
  }

  // Pointer drags: listeners live on window and are removed on pointerup, or on unmount,
  // which also ends the host's gesture so it never stays open.
  let endDrag: (() => void) | null = null;
  onDestroy(() => endDrag?.());

  function startDrag(
    e: PointerEvent,
    next: (state: ColorPickerState, x: number, y: number) => ColorPickerState
  ) {
    if (disabled) return;
    e.preventDefault();
    endDrag?.();
    emitGestureStart();

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const update = (clientX: number, clientY: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      pickerState = next(pickerState, x, y);
      emitChange(pickerStateToHex(pickerState, alpha));
    };
    update(e.clientX, e.clientY);

    const onPointerMove = (ev: PointerEvent) => update(ev.clientX, ev.clientY);
    const end = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      endDrag = null;
      emitGestureEnd();
    };
    const onPointerUp = () => {
      end();
      recordRecent(pickerStateToHex(pickerState, alpha));
    };
    endDrag = end;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  const handleAreaPointerDown = (e: PointerEvent) =>
    startDrag(e, (state, x, y) => pickerStateFromArea(state, x, y));
  const handleHuePointerDown = (e: PointerEvent) => startDrag(e, (state, x) => pickerStateFromHue(state, x));
  const handleAlphaPointerDown = (e: PointerEvent) =>
    startDrag(e, (state, x) => pickerStateFromAlpha(state, x));

  // Keyboard navigation
  function handleAreaKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, 'area', e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      pickerState = next;
      emitChange(pickerStateToHex(next, alpha));
      recordRecent(pickerStateToHex(next, alpha));
    }
  }

  function handleHueKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, 'hue', e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      pickerState = next;
      emitChange(pickerStateToHex(next, alpha));
      recordRecent(pickerStateToHex(next, alpha));
    }
  }

  function handleAlphaKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    const next = pickerKeyStep(pickerState, 'alpha', e.key, e.shiftKey);
    if (next) {
      e.preventDefault();
      pickerState = next;
      emitChange(pickerStateToHex(next, alpha));
      recordRecent(pickerStateToHex(next, alpha));
    }
  }

  const computedClass = $derived(classProp || className || '');
</script>

<div
  {id}
  role="group"
  aria-label={ariaLabel}
  class={computedClass}
  style="box-sizing: border-box; width: var(--pixerate-color-picker-width, 240px); border-radius: var(--pixerate-color-picker-radius, 8px); background: var(--pixerate-color-picker-bg, #1f2430); color: var(--pixerate-color-picker-fg, #f0f2f5); padding: 12px; display: flex; flex-direction: column; gap: 10px; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; user-select: none; opacity: {disabled ? 0.6 : 1}; pointer-events: {disabled ? 'none' : 'auto'};"
>
  <!-- Live region for accessibility announcements -->
  <span
    role="status"
    aria-live="polite"
    style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;"
  >
    {liveDescription}
  </span>

  <!-- 2D Area: Saturation and Brightness -->
  <div
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label="Saturation and brightness"
    aria-valuenow={Math.round(pickerState.v * 100)}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuetext="Saturation {Math.round(pickerState.s * 100)}%, Brightness {Math.round(pickerState.v * 100)}%"
    aria-disabled={disabled}
    onpointerdown={handleAreaPointerDown}
    onkeydown={handleAreaKeyDown}
    style="position: relative; width: 100%; height: 150px; border-radius: 6px; background: {areaBg}; cursor: {disabled ? 'default' : 'crosshair'}; touch-action: none; outline: none;"
  >
    <!-- Thumb -->
    <div
      style="position: absolute; width: var(--pixerate-color-picker-thumb-size, 14px); height: var(--pixerate-color-picker-thumb-size, 14px); border-radius: 50%; transform: translate(-50%, -50%); left: {pickerState.s * 100}%; top: {(1 - pickerState.v) * 100}%; border: 2px solid #ffffff; box-shadow: 0 0 2px 1px rgba(0,0,0,0.6); pointer-events: none; background-color: {currentHex};"
    ></div>
  </div>

  <!-- Hue Slider -->
  <div
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label="Hue"
    aria-valuenow={Math.round(pickerState.h)}
    aria-valuemin={0}
    aria-valuemax={360}
    aria-valuetext="{Math.round(pickerState.h)} degrees"
    aria-disabled={disabled}
    onpointerdown={handleHuePointerDown}
    onkeydown={handleHueKeyDown}
    style="position: relative; width: 100%; height: 12px; border-radius: 6px; background: {PICKER_HUE_BACKGROUND}; cursor: {disabled ? 'default' : 'pointer'}; touch-action: none; outline: none;"
  >
    <div
      style="position: absolute; top: 50%; transform: translate(-50%, -50%); left: {(pickerState.h / 360) * 100}%; width: var(--pixerate-color-picker-thumb-size, 14px); height: var(--pixerate-color-picker-thumb-size, 14px); border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 2px 1px rgba(0,0,0,0.6); pointer-events: none; background-color: hsl({pickerState.h}, 100%, 50%);"
    ></div>
  </div>

  <!-- Alpha Slider (conditional) -->
  {#if alpha}
    <div
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label="Alpha"
      aria-valuenow={Math.round(pickerState.alpha * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext="{Math.round(pickerState.alpha * 100)}%"
      aria-disabled={disabled}
      onpointerdown={handleAlphaPointerDown}
      onkeydown={handleAlphaKeyDown}
      style="position: relative; width: 100%; height: 12px; border-radius: 6px; background-image: {CHECKERBOARD_BG}; background-size: 8px 8px; cursor: {disabled ? 'default' : 'pointer'}; touch-action: none; outline: none; overflow: hidden;"
    >
      <div
        style="position: absolute; inset: 0; background: {alphaBg};"
      ></div>
      <div
        style="position: absolute; top: 50%; transform: translate(-50%, -50%); left: {pickerState.alpha * 100}%; width: var(--pixerate-color-picker-thumb-size, 14px); height: var(--pixerate-color-picker-thumb-size, 14px); border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 2px 1px rgba(0,0,0,0.6); pointer-events: none; background-color: {currentHex};"
      ></div>
    </div>
  {/if}

  <!-- Controls row: Swatch preview, Text Input, EyeDropper, Gamut Warning -->
  <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
    <!-- Preview swatch with checkerboard -->
    <div
      style="position: relative; width: 28px; height: 28px; border-radius: 4px; background-image: {CHECKERBOARD_BG}; background-size: 8px 8px; overflow: hidden; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.15);"
    >
      <div
        style="width: 100%; height: 100%; background-color: {currentHex};"
      ></div>
    </div>

    <!-- Text Field -->
    <input
      type="text"
      value={textDraft}
      {disabled}
      aria-label="Color hex or CSS string"
      aria-invalid={isInvalid ? 'true' : undefined}
      oninput={(e) => {
        isTyping = true;
        textDraft = e.currentTarget.value;
        isInvalid = false;
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTextInput(e.currentTarget);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          isTyping = false;
          isInvalid = false;
          textDraft = value;
          e.currentTarget.value = value;
        }
      }}
      onblur={(e) => commitTextInput(e.currentTarget)}
      style="flex: 1; min-width: 0; height: 28px; padding: 0 8px; font-size: 12px; font-family: monospace; border-radius: 4px; border: {isInvalid ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.2)'}; background: rgba(0,0,0,0.2); color: inherit; outline: none;"
    />

    <!-- EyeDropper button -->
    {#if hasEyeDropper}
      <button
        type="button"
        {disabled}
        aria-label="Pick color from screen"
        title="Pick color from screen"
        onclick={handleEyeDropper}
        style="display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: transparent; color: inherit; cursor: {disabled ? 'default' : 'pointer'};"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m19 11-8-8-8.5 8.5a2.12 2.12 0 0 0 0 3l2.5 2.5 1.5-1.5" />
          <path d="m5 16-3 3 1 1 3-3" />
          <path d="m14 6 4 4" />
        </svg>
      </button>
    {/if}
  </div>

  <!-- Gamut clipping warning -->
  {#if isClipped}
    <div
      role="note"
      title="This colour was outside standard sRGB and clipped."
      style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 2px 6px; border-radius: 4px; align-self: flex-start;"
    >
      <span>⚠ Clipped to sRGB</span>
    </div>
  {/if}

  <!-- Contrast badge -->
  {#if contrastResult}
    <div
      style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; padding: 4px 8px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);"
    >
      <span>
        Contrast: <strong>{contrastResult.ratio.toFixed(2)}:1</strong>
      </span>
      <div style="display: flex; gap: 6px;">
        <span
          style="color: {contrastResult.aa ? '#10b981' : '#ef4444'}; font-weight: 600;"
        >
          AA {contrastResult.aa ? '✓' : '✗'}
        </span>
        <span
          style="color: {contrastResult.aaa ? '#10b981' : '#ef4444'}; font-weight: 600;"
        >
          AAA {contrastResult.aaa ? '✓' : '✗'}
        </span>
      </div>
    </div>
  {/if}

  <!-- Palette Swatches -->
  {#if swatches && swatches.length > 0}
    <div style="display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 10px; text-transform: uppercase; opacity: 0.6;">
        Palette
      </span>
      <div style="display: flex; flex-wrap: wrap; gap: 4px;">
        {#each swatches as color, idx (`${color}-${idx}`)}
          <button
            type="button"
            data-testid="color-picker-swatch"
            title={color}
            {disabled}
            aria-label="Color {color}"
            onclick={() => {
              emitChange(color);
              recordRecent(color);
            }}
            style="width: 18px; height: 18px; border-radius: 3px; background-color: {color}; border: {color.toLowerCase() === value.toLowerCase() ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.2)'}; cursor: {disabled ? 'default' : 'pointer'}; padding: 0; outline: none;"
          ></button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Recent Colours -->
  {#if activeRecent.length > 0}
    <div style="display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 10px; text-transform: uppercase; opacity: 0.6;">
        Recent
      </span>
      <div style="display: flex; flex-wrap: wrap; gap: 4px;">
        {#each activeRecent as color, idx (`recent-${color}-${idx}`)}
          <button
            type="button"
            data-testid="color-picker-recent"
            {disabled}
            aria-label="Color {color}"
            onclick={() => {
              emitChange(color);
              recordRecent(color);
            }}
            style="width: 18px; height: 18px; border-radius: 3px; background-color: {color}; border: {color.toLowerCase() === value.toLowerCase() ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.2)'}; cursor: {disabled ? 'default' : 'pointer'}; padding: 0; outline: none;"
          ></button>
        {/each}
      </div>
    </div>
  {/if}
</div>
