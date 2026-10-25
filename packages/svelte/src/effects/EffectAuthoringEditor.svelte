<script lang="ts">
  import { onDestroy } from 'svelte';
  import { effectSampleInputs, type EffectAuthoringSession, type EffectRenderer } from '@pixerate/editor/effects';
  import { effectAuthoringOf } from './effects.svelte.js';
  import EffectParameters from './EffectParameters.svelte';

  interface Props {
    /** The effect authoring session to edit. */
    session: EffectAuthoringSession | null;
    /** Whether to show the source code editor pane when supported (default true). */
    showSource?: boolean;
    /** Whether to show the keyframe timeline below parameters (default true). */
    showTimeline?: boolean;
    /** Size of the preview canvas (default 480 × 270). */
    previewSize?: { width: number; height: number };
    class?: string;
  }

  let {
    session,
    showSource = true,
    showTimeline = true,
    previewSize = { width: 480, height: 270 },
    class: className = ''
  }: Props = $props();

  const authoring = effectAuthoringOf(() => session);
  const current = $derived(authoring.state);

  // Preview renderer lifecycle
  let canvas: HTMLCanvasElement | null = $state(null);
  let renderer: EffectRenderer | null = $state.raw(null);
  let rendering = false;
  let pending = false;

  // Preset saving state
  let savingPreset = $state(false);
  let presetName = $state('');

  // Source code pane state
  let textarea: HTMLTextAreaElement | null = $state(null);
  let gutter: HTMLDivElement | null = $state(null);
  let sourceCode = $state('');
  let sourceDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Sync preview renderer
  $effect(() => {
    const s = session;
    const w = previewSize.width;
    const h = previewSize.height;

    if (!s) {
      if (renderer) {
        renderer.dispose();
        renderer = null;
      }
      return;
    }

    let live = true;
    let createdRenderer: EffectRenderer | null = null;

    Promise.resolve(s.createPreview({ width: w, height: h })).then((r) => {
      if (!live) {
        r.dispose();
        return;
      }
      createdRenderer = r;
      renderer = r;
    });

    return () => {
      live = false;
      if (createdRenderer) {
        createdRenderer.dispose();
      }
      if (renderer === createdRenderer) {
        renderer = null;
      }
    };
  });

  // Draws frames one at a time. A change while a frame renders asks for one more frame, which
  // then shows the latest playhead and values, so the preview never stops on a stale frame.
  let latestTime = 0;
  /** Sample pictures for the effect's image inputs, so filters and transitions show something. */
  const inputSpecs = $derived(current?.description.inputs);
  const sampleInputs = $derived(inputSpecs ? effectSampleInputs({ inputs: inputSpecs }, previewSize) : {});
  async function pump() {
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    try {
      do {
        pending = false;
        const r = renderer;
        if (!r) break;
        try {
          const pixels = await r.render({ time: latestTime, inputs: sampleInputs });
          const ctx = renderer === r ? canvas?.getContext('2d') : null;
          if (ctx && typeof ImageData !== 'undefined') {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
          }
        } catch {
          // A failed frame (for example a disposed renderer) is skipped; the next change draws again.
        }
      } while (pending);
    } finally {
      rendering = false;
    }
  }

  $effect(() => {
    const st = current;
    if (!renderer || !st) return;
    latestTime = st.time;
    void pump();
  });

  // Sync source code when the session's source changes
  $effect(() => {
    if (current?.source !== null && current?.source !== undefined) {
      sourceCode = current.source;
    }
  });

  onDestroy(() => {
    if (sourceDebounceTimer) clearTimeout(sourceDebounceTimer);
  });

  function handleSourceInput(e: Event & { currentTarget: HTMLTextAreaElement }) {
    const val = e.currentTarget.value;
    sourceCode = val;
    if (sourceDebounceTimer) clearTimeout(sourceDebounceTimer);
    sourceDebounceTimer = setTimeout(() => {
      session?.setSource?.(val);
    }, 300);
  }

  function handleSavePreset(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = presetName.trim();
    if (trimmed && session) {
      session.savePreset(trimmed);
      savingPreset = false;
      presetName = '';
    }
  }

  function jumpToLine(lineNum: number) {
    if (!textarea) return;
    const lines = sourceCode.split('\n');
    let offset = 0;
    for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
  }

  const hasSource = $derived(
    showSource && current?.sourceLanguage !== null && typeof session?.setSource === 'function'
  );

  const sourceLines = $derived(sourceCode.split('\n'));
  const issueLines = $derived(
    new Set((current?.issues ?? []).map((i) => i.line).filter((l): l is number => typeof l === 'number'))
  );
</script>

{#if !session || !current}
  <div class="p-4 text-center text-xs text-muted-foreground {className}">
    No effect authoring session is open.
  </div>
{:else}
  <div class="space-y-4 rounded border border-border bg-background p-4 text-foreground {className}" data-effect-authoring-editor={current.name}>
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
          aria-label={current.playing ? 'Pause playback' : 'Start playback'}
          onclick={() => (current.playing ? session?.pause() : session?.play())}
        >
          {current.playing ? 'Pause' : 'Play'}
        </button>
        <span class="font-mono text-xs text-muted-foreground" data-time-readout>
          {current.time}ms / {current.duration}ms
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted"
          aria-label="Undo"
          disabled={!current.canUndo}
          onclick={() => session?.undo()}
        >
          Undo
        </button>
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted"
          aria-label="Redo"
          disabled={!current.canRedo}
          onclick={() => session?.redo()}
        >
          Redo
        </button>

        {#if savingPreset}
          <form onsubmit={handleSavePreset} class="flex items-center gap-1">
            <input
              type="text"
              class="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
              placeholder="Preset name"
              bind:value={presetName}
            />
            <button
              type="submit"
              class="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground"
            >
              Save
            </button>
            <button
              type="button"
              class="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-muted"
              onclick={() => (savingPreset = false)}
            >
              Cancel
            </button>
          </form>
        {:else}
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
            onclick={() => (savingPreset = true)}
          >
            Save preset…
          </button>
        {/if}
      </div>
    </div>

    <!-- Main workspace: Preview + Source -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <!-- Preview Panel -->
      <div class="space-y-2">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </div>
        <div class="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded border border-border bg-black">
          <canvas
            bind:this={canvas}
            width={previewSize.width}
            height={previewSize.height}
            class="h-full w-full object-contain"
            aria-label="Effect preview canvas"
          ></canvas>
        </div>
        {#if current.issues.length > 0}
          <div class="space-y-1 rounded border border-destructive/20 bg-destructive/10 p-2 text-xs" data-effect-issues>
            {#each current.issues as issue, idx (idx)}
              <button
                type="button"
                class="block w-full text-left {issue.severity === 'error' ? 'text-destructive' : 'text-amber-500'}"
                onclick={() => issue.line !== undefined && jumpToLine(issue.line)}
              >
                {issue.line !== undefined ? `Line ${issue.line}: ` : ''}
                {issue.message}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Source Code Pane -->
      {#if hasSource}
        <div class="space-y-2" data-effect-source-pane>
          <div class="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Source ({current.sourceLanguage})</span>
          </div>
          <div class="flex h-64 rounded border border-border bg-muted/20 font-mono text-xs">
            <!-- Line Gutter -->
            <div bind:this={gutter} class="select-none overflow-hidden border-r border-border bg-muted/40 px-2 py-2 text-right text-muted-foreground" aria-hidden="true">
              {#each sourceLines as _, i (i)}
                {@const lineNum = i + 1}
                {@const hasIssue = issueLines.has(lineNum)}
                <div data-gutter-line={lineNum} class={hasIssue ? 'font-bold text-destructive' : ''}>
                  {lineNum}
                </div>
              {/each}
            </div>
            <!-- Textarea -->
            <textarea
              bind:this={textarea}
              value={sourceCode}
              oninput={handleSourceInput}
              onscroll={(e) => {
                if (gutter) gutter.scrollTop = e.currentTarget.scrollTop;
              }}
              wrap="off"
              aria-label="Effect source code"
              spellcheck="false"
              class="flex-1 resize-none bg-transparent p-2 font-mono text-xs text-foreground focus:outline-none"
            ></textarea>
          </div>
        </div>
      {/if}
    </div>

    <!-- Parameters -->
    <div class="space-y-2 border-t border-border pt-4">
      <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Parameters
      </div>
      <EffectParameters
        description={current.description}
        values={current.values}
        onchange={(control, val, gesture) => session?.setValue(control, val as any, { gesture })}
        onreset={(control) => session?.resetValues([control])}
        onpresetname={(name) => session?.applyPreset(name)}
      >
        {#snippet addon(control: string)}
          {@const track = current.tracks[control]}
          {@const isAnimated = Boolean(track && track.length > 0)}
          {@const hasKeyframeAtPlayhead = Boolean(isAnimated && track?.some((kf) => kf.time === current.time))}
          <button
            type="button"
            data-keyframe-toggle={control}
            aria-label={
              hasKeyframeAtPlayhead
                ? `Remove keyframe for ${control}`
                : `Add keyframe for ${control}`
            }
            onclick={() => {
              if (hasKeyframeAtPlayhead) {
                session?.removeKeyframe(control, current.time);
              } else {
                session?.setKeyframe(control, current.time);
              }
            }}
            class="rounded px-1 text-xs transition-colors {hasKeyframeAtPlayhead ? 'text-primary font-bold' : isAnimated ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"
            title={hasKeyframeAtPlayhead ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
          >
            {hasKeyframeAtPlayhead ? '◆' : '◇'}
          </button>
        {/snippet}
      </EffectParameters>
    </div>

    <!-- Keyframe Timeline -->
    {#if showTimeline}
      <div class="space-y-3 border-t border-border pt-4" data-effect-timeline>
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Timeline
          </div>
          <div class="flex items-center gap-3 text-xs">
            <label class="flex items-center gap-1.5">
              <span>Duration:</span>
              <input
                type="number"
                aria-label="Duration"
                min={1}
                value={current.duration}
                onchange={(e) =>
                  session?.setTiming({ duration: Math.max(1, Number(e.currentTarget.value)) })
                }
                class="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono"
              />
              <span class="text-muted-foreground">ms</span>
            </label>

            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                aria-label="Loop playback"
                checked={current.loop}
                onchange={(e) => session?.setTiming({ loop: e.currentTarget.checked })}
              />
              <span>Loop</span>
            </label>
          </div>
        </div>

        <!-- Scrubber -->
        <div class="space-y-1">
          <input
            type="range"
            aria-label="Timeline scrubber"
            min={0}
            max={current.duration}
            value={current.time}
            oninput={(e) => session?.seek(Number(e.currentTarget.value))}
            class="w-full cursor-pointer accent-primary"
          />
        </div>

        <!-- Tracks -->
        {#if Object.entries(current.tracks).length > 0}
          <div class="space-y-2 pt-1">
            {#each Object.entries(current.tracks) as [control, keyframes] (control)}
              {#if keyframes && keyframes.length > 0}
                <div class="space-y-1" data-track={control}>
                  <div class="flex items-center justify-between text-xs text-muted-foreground">
                    <span class="font-medium">{control}</span>
                    <button
                      type="button"
                      class="text-[11px] hover:text-foreground"
                      onclick={() => session?.clearTrack(control)}
                      aria-label="Clear animation track for {control}"
                    >
                      Clear track
                    </button>
                  </div>
                  <div class="relative h-4 w-full rounded bg-muted/40">
                    {#each keyframes as kf, i (i)}
                      {@const leftPct = Math.max(
                        0,
                        Math.min(100, (kf.time / (current.duration || 1)) * 100)
                      )}
                      <button
                        type="button"
                        onclick={() => session?.seek(kf.time)}
                        aria-label="Seek to {control} keyframe at {kf.time}ms"
                        title="{control} @ {kf.time}ms"
                        style="left: {leftPct}%;"
                        class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] text-primary hover:scale-125"
                      >
                        ◆
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
