import React, { useRef, useState } from 'react';
import { describeChartSelection, downloadChartPng, locateChartPoint, ChartPresence, type ChartController, type ChartScene, type DownloadChartPngOptions } from '@pixerate/editor/chart';
import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { usePlaybackSurface } from '../playback/usePlaybackSurface';
import { PresenceLayer } from '../playback/PresenceLayer';
import { ChartCanvas, type ChartCanvasProps } from './ChartCanvas';
import { ChartDataGrid } from './ChartDataGrid';
import { ChartInspector } from './ChartInspector';
import { useChartState } from './useChartEditor';
import { chartButtonClass } from './styles';

export interface ChartEditorProps {
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
  canvasProps?: Omit<ChartCanvasProps, 'controller' | 'height'>;
  className?: string;
  /**
   * Agent playback: act out the chart tools' calls here with the agent's cursor, on the inspector,
   * the data grid and the toolbar (default: the nearest `AgentPlaybackProvider`; `null` turns it
   * off). With `canvasProps.presence` (a `ChartDirector`'s), the director's drags share the cursor.
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `chart`, where the chart tool provider plays). */
  playbackId?: string;
  /** Bring the editor on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

/** Toolbar, chart, settings sidebar and data grid for a `ChartController`. */
export function ChartEditor({ controller, showInspector = true, showDataGrid = true, showToolbar = true, pngOptions, height = 380, canvasProps, className, playback, playbackId = 'chart', onPlaybackReveal }: ChartEditorProps) {
  const state = useChartState(controller);

  // Agent playback in the chart's scene coordinates, so a director's drags (in the same presence
  // store) and the editor's own controls share one cursor. Controls outside the chart are mapped
  // into scene units through the SVG's box.
  const rootRef = useRef<HTMLDivElement>(null);
  const ownScene = useRef<ChartScene | null>(null);
  const sceneRef = canvasProps?.sceneRef ?? ownScene;
  const [ownPresence] = useState(() => new ChartPresence());
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const svgBox = () => {
    const svg = rootRef.current?.querySelector<SVGSVGElement>('[data-chart-canvas] svg');
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
    const el = rootRef.current?.querySelector(selector);
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
    grid: () => '[data-chart-grid]',
  };
  const presence = usePlaybackSurface(playing, playbackId, {
    defaultKind: 'point',
    locate: (ref: PlaybackRef) => {
      if (ref.kind === 'point') return sceneRef.current ? locateChartPoint(controller.getSpec(), sceneRef.current, ref) : null;
      const selector = SELECTORS[ref.kind]?.(ref.id);
      return selector ? elementRect(selector) : null;
    },
    bounds: () => (sceneRef.current ? { x: 0, y: 0, width: sceneRef.current.width, height: sceneRef.current.height } : null),
    visible: () => {
      const r = rootRef.current?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p) => sceneToClient(p) ?? p,
    fromViewport: (p) => clientToScene(p) ?? p,
    reveal: () => onPlaybackReveal?.(),
  // A director's presence store when there is one, so its cursor and this one are the same.
  }, canvasProps?.presence ?? ownPresence);
  /** Scene units → pixels in the editor's root, for the cursor layer. */
  const sceneToRoot = (p: PlaybackPoint): PlaybackPoint => {
    const c = sceneToClient(p);
    const box = rootRef.current?.getBoundingClientRect();
    return c && box ? { x: c.x - box.left, y: c.y - box.top } : p;
  };
  const [pngError, setPngError] = useState<string | null>(null);
  const downloadPng = () => {
    setPngError(null);
    downloadChartPng(controller.toJSON(), pngOptions).catch((error: unknown) => setPngError(error instanceof Error ? error.message : String(error)));
  };
  return (
    <div ref={rootRef} className={`relative flex flex-col gap-2 ${className ?? ''}`} data-chart-editor="">
      {playing && <PresenceLayer presence={presence} viewport={sceneToRoot} />}
      {showToolbar && (
        <div className="flex items-center gap-1" data-chart-toolbar="">
          <button type="button" className={chartButtonClass} disabled={!state.canUndo} title={state.undoLabel ? `Undo ${state.undoLabel}` : 'Undo'} data-action="undo" onClick={() => controller.undo()}>
            Undo
          </button>
          <button type="button" className={chartButtonClass} disabled={!state.canRedo} title={state.redoLabel ? `Redo ${state.redoLabel}` : 'Redo'} data-action="redo" onClick={() => controller.redo()}>
            Redo
          </button>
          <button type="button" className={chartButtonClass} title="Download the chart as a PNG image" data-action="download-png" onClick={downloadPng}>
            Download PNG
          </button>
          <span className="ml-2 truncate text-xs text-muted-foreground" data-chart-selection="" aria-live="polite">
            {describeChartSelection(controller, state.selection)}
          </span>
        </div>
      )}
      {pngError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-png-error="">
          {pngError}
        </p>
      )}
      {state.issues.length > 0 && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-issues="">
          {state.issues.map((i) => i.message).join(' ')}
        </p>
      )}
      <div className="flex min-h-0 flex-col gap-2 md:flex-row">
        <div className="min-w-0 flex-1 rounded-md border border-border bg-background p-1">
          {/* With playback the editor draws the cursor (over the inspector too), so the canvas doesn't. */}
          <ChartCanvas controller={controller} height={height} {...canvasProps} sceneRef={sceneRef} presence={playing ? undefined : canvasProps?.presence} />
        </div>
        {showInspector && (
          // Side by side, the canvas sets the row's height and the inspector scrolls within it.
          <div className="relative w-full shrink-0 md:w-64">
            <ChartInspector controller={controller} className="overflow-y-auto rounded-md border border-border p-3 md:absolute md:inset-0" />
          </div>
        )}
      </div>
      {showDataGrid && <ChartDataGrid controller={controller} />}
    </div>
  );
}
