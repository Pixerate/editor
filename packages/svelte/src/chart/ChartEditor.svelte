<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { describeChartSelection, downloadChartPng, locateChartPoint, ChartPresence, type ChartController, type ChartScene, type DownloadChartPngOptions } from '@pixerate/editor/chart';
  import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
  import { createPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';
  import ChartCanvas from './ChartCanvas.svelte';
  import ChartDataGrid from './ChartDataGrid.svelte';
  import ChartInspector from './ChartInspector.svelte';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import { chartButtonClass } from './styles.js';

  interface Props {
    controller: ChartController;
    /** The settings sidebar (default `true`). */
    showInspector?: boolean;
    /** The data grid under the chart (default `true`). */
    showDataGrid?: boolean;
    /** Undo / redo, Download PNG and the selection readout (default `true`). */
    showToolbar?: boolean;
    /** Size, theme, scale and file name for the toolbar's Download PNG (default 800 × 450, light theme). */
    pngOptions?: DownloadChartPngOptions;
    /** Chart height in pixels (default 380). */
    height?: number;
    canvasProps?: Omit<ComponentProps<typeof ChartCanvas>, 'controller' | 'height'>;
    class?: string;
    /**
     * Agent playback: act out the chart tools' calls here with the agent's cursor, on the inspector,
     * the data grid and the toolbar (default: `setAgentPlayback` above; `null` turns it off). With
     * `canvasProps.presence` (a `ChartDirector`'s), the director's drags share the cursor.
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `chart`, where the chart tool provider plays). */
    playbackId?: string;
    /** Bring the editor on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }

  let { controller, showInspector = true, showDataGrid = true, showToolbar = true, pngOptions, height = 380, canvasProps = {}, class: className = '', playback, playbackId = 'chart', onplaybackreveal }: Props = $props();

  // Agent playback in the chart's scene coordinates, so a director's drags (in the same presence
  // store) and the editor's own controls share one cursor. Controls outside the chart are mapped
  // into scene units through the SVG's box.
  let root: HTMLDivElement | undefined = $state();
  const ownScene: { current: ChartScene | null } = { current: null };
  const sceneRef = $derived(canvasProps.sceneRef ?? ownScene);
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  const svgBox = () => {
    const svg = root?.querySelector<SVGSVGElement>('[data-chart-canvas] svg');
    const r = svg?.getBoundingClientRect();
    const vb = svg?.viewBox?.baseVal;
    if (!svg || !r || !vb || !vb.width || !vb.height) return null;
    return { left: r.left, top: r.top, sx: r.width / vb.width, sy: r.height / vb.height, vx: vb.x, vy: vb.y };
  };
  const sceneToClient = (p: PlaybackPoint): PlaybackPoint | null => {
    const b = svgBox();
    return b ? { x: b.left + (p.x - b.vx) * b.sx, y: b.top + (p.y - b.vy) * b.sy } : null;
  };
  const clientToScene = (p: PlaybackPoint): PlaybackPoint | null => {
    const b = svgBox();
    return b && b.sx && b.sy ? { x: (p.x - b.left) / b.sx + b.vx, y: (p.y - b.top) / b.sy + b.vy } : null;
  };
  const elementRect = (selector: string): PlaybackRect | null => {
    const el = root?.querySelector(selector);
    // The inspector scrolls on its own: bring the control into its view first.
    el?.scrollIntoView?.({ block: 'nearest' });
    const r = el?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    const a = clientToScene({ x: r.left, y: r.top });
    const b = clientToScene({ x: r.right, y: r.bottom });
    return a && b ? { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } : null;
  };
  const SELECTORS: Record<string, (id: string) => string> = {
    control: (id) => `[data-option="${CSS.escape(id)}"]`,
    'chart-type': (id) => `[data-chart-type="${CSS.escape(id)}"]`,
    action: (id) => `[data-action="${CSS.escape(id)}"]`,
    grid: () => '[data-chart-grid]'
  };
  // svelte-ignore state_referenced_locally
  const ownPresence = canvasProps.presence ?? new ChartPresence();
  const presence = createPlaybackSurface(() => playing, () => playbackId, () => ({
    defaultKind: 'point',
    locate: (ref: PlaybackRef) => {
      if (ref.kind === 'point') return sceneRef.current ? locateChartPoint(controller.getSpec(), sceneRef.current, ref) : null;
      const selector = SELECTORS[ref.kind]?.(ref.id);
      return selector ? elementRect(selector) : null;
    },
    bounds: () => (sceneRef.current ? { x: 0, y: 0, width: sceneRef.current.width, height: sceneRef.current.height } : null),
    visible: () => {
      const r = root?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p: PlaybackPoint) => sceneToClient(p) ?? p,
    fromViewport: (p: PlaybackPoint) => clientToScene(p) ?? p,
    reveal: () => onplaybackreveal?.()
  }), ownPresence);
  /** Scene units → pixels in the editor's root, for the cursor layer. */
  const sceneToRoot = (p: PlaybackPoint): PlaybackPoint => {
    const c = sceneToClient(p);
    const box = root?.getBoundingClientRect();
    return c && box ? { x: c.x - box.left, y: c.y - box.top } : p;
  };

  const view = chartStateOf(() => controller);
  const chart = $derived(view.current);
  let pngError = $state<string | null>(null);
  function downloadPng() {
    pngError = null;
    downloadChartPng(controller.toJSON(), pngOptions).catch((error: unknown) => (pngError = error instanceof Error ? error.message : String(error)));
  }
</script>

<div bind:this={root} class="relative flex flex-col gap-2 {className}" data-chart-editor="">
  {#if playing}
    <PresenceLayer {presence} viewport={sceneToRoot} />
  {/if}
  {#if showToolbar}
    <div class="flex items-center gap-1" data-chart-toolbar="">
      <button type="button" class={chartButtonClass} disabled={!chart.canUndo} title={chart.undoLabel ? `Undo ${chart.undoLabel}` : 'Undo'} data-action="undo" onclick={() => controller.undo()}>Undo</button>
      <button type="button" class={chartButtonClass} disabled={!chart.canRedo} title={chart.redoLabel ? `Redo ${chart.redoLabel}` : 'Redo'} data-action="redo" onclick={() => controller.redo()}>Redo</button>
      <button type="button" class={chartButtonClass} title="Download the chart as a PNG image" data-action="download-png" onclick={downloadPng}>Download PNG</button>
      <span class="ml-2 truncate text-xs text-muted-foreground" data-chart-selection="" aria-live="polite">{describeChartSelection(controller, chart.selection)}</span>
    </div>
  {/if}
  {#if pngError}
    <p role="alert" class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-png-error="">{pngError}</p>
  {/if}
  {#if chart.issues.length > 0}
    <p role="alert" class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-issues="">
      {chart.issues.map((i) => i.message).join(' ')}
    </p>
  {/if}
  <div class="flex min-h-0 flex-col gap-2 md:flex-row">
    <div class="min-w-0 flex-1 rounded-md border border-border bg-background p-1">
      <!-- With playback the editor draws the cursor (over the inspector too), so the canvas doesn't. -->
      <ChartCanvas {controller} {height} {...canvasProps} {sceneRef} presence={playing ? undefined : canvasProps.presence} />
    </div>
    {#if showInspector}
      <!-- Side by side, the canvas sets the row's height and the inspector scrolls within it. -->
      <div class="relative w-full shrink-0 md:w-64">
        <ChartInspector {controller} class="overflow-y-auto rounded-md border border-border p-3 md:absolute md:inset-0" />
      </div>
    {/if}
  </div>
  {#if showDataGrid}
    <ChartDataGrid {controller} />
  {/if}
</div>
