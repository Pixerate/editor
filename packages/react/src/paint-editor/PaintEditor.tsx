import React, { useRef, useState } from 'react';
import { PaintPresence, documentToScreen, screenToDocument, type PaintEditorController, type PaintTool } from '@pixerate/editor/paint-editor';
import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { usePlaybackSurface } from '../playback/usePlaybackSurface';
import { PresenceLayer } from '../playback/PresenceLayer';
import { BrushPanel } from './BrushPanel';
import { ColorPanel } from './ColorPanel';
import { PaintCanvas } from './PaintCanvas';
import { PaintLayersPanel } from './PaintLayersPanel';
import { PaintToolbar } from './PaintToolbar';
import { PaperPanel } from './PaperPanel';
import { WetPanel } from './WetPanel';
import { StickerPanel } from './StickerPanel';
import { PaintEffectsPanel, usePaintEffectsProvider } from './PaintEffectsPanel';
import { chip } from './shared';

export interface PaintEditorProps {
  controller: PaintEditorController;
  /** Base name of saved and exported files (default `painting`). */
  fileName?: string;
  /** Height of the editor (default 720 px). */
  height?: number | string;
  /** Agent cursors to draw over the canvas (see `usePaintDirector`). */
  presence?: PaintPresence;
  className?: string;
  /**
   * Agent playback: act out the paint tools' calls here with the agent's cursor, opening the panel
   * each write belongs to (default: the nearest `AgentPlaybackProvider`; `null` turns it off). With
   * `presence` (a `PaintDirector`'s), the director's strokes share the cursor.
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `paint`, where the paint tool providers play). */
  playbackId?: string;
  /** Bring the editor on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

/** Controls a paint plan can point at, by `{ kind: 'control', id }`. */
const PAINT_CONTROLS: Record<string, string> = {
  'mixing-pad': '[data-testid="mixing-pad"]',
  lighting: '[data-testid="light-panel"]',
  symmetry: '[aria-label="Symmetry"]',
};

type SideTab = 'color' | 'wet' | 'paper' | 'layers' | 'effects';

/**
 * The paint editor: toolbar, brush library on the left, the canvas, and colour (wheel,
 * harmonies, swatches, mixing pad), wet media, paper and layers on the right, and provider effects
 * when an effects provider is registered.
 */
export const PaintEditor: React.FC<PaintEditorProps> = ({ controller, fileName, height = 720, presence, className, playback, playbackId = 'paint', onPlaybackReveal }) => {
  const [tool, setTool] = useState<PaintTool>('brush');
  const [tab, setTab] = useState<SideTab>('color');
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Agent playback in document pixels, sharing a director's presence store (one cursor). Panels
  // outside the canvas are mapped into document pixels through the canvas view.
  const rootRef = useRef<HTMLDivElement>(null);
  const [ownPresence] = useState(() => new PaintPresence());
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const viewBox = () => {
    const el = rootRef.current?.querySelector<HTMLElement>('[data-testid="paint-canvas"]');
    const r = el?.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  };
  const docToClient = (p: PlaybackPoint): PlaybackPoint | null => {
    const r = viewBox();
    if (!r) return null;
    const q = documentToScreen(controller.getState().view, controller.document.canvas, { width: r.width, height: r.height }, p.x, p.y);
    return { x: r.left + q.x, y: r.top + q.y };
  };
  const clientToDoc = (p: PlaybackPoint): PlaybackPoint | null => {
    const r = viewBox();
    return r ? screenToDocument(controller.getState().view, controller.document.canvas, { width: r.width, height: r.height }, p.x - r.left, p.y - r.top) : null;
  };
  const elementRect = (selector: string): PlaybackRect | null => {
    const r = rootRef.current?.querySelector(selector)?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    // Map the element's centre and size (the view may rotate; the cursor only needs the centre).
    const c = clientToDoc({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const zoom = controller.getState().view.zoom || 1;
    return c ? { x: c.x - r.width / zoom / 2, y: c.y - r.height / zoom / 2, width: r.width / zoom, height: r.height / zoom } : null;
  };
  const agentPresence = usePlaybackSurface(
    playing,
    playbackId,
    {
      locate: (ref: PlaybackRef) => {
        if (ref.kind === 'panel') return elementRect(`[data-paint-tab="${CSS.escape(ref.id)}"]`);
        if (ref.kind === 'panel-body') return elementRect(`[data-paint-panel="${CSS.escape(ref.id)}"]`);
        if (ref.kind === 'control' && PAINT_CONTROLS[ref.id]) return elementRect(PAINT_CONTROLS[ref.id]!);
        return null;
      },
      open: async (ref: PlaybackRef) => {
        if (ref.kind !== 'panel' || tabRef.current === ref.id) return;
        rootRef.current?.querySelector<HTMLElement>(`[data-paint-tab="${CSS.escape(ref.id)}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      bounds: () => ({ x: 0, y: 0, width: controller.document.canvas.width, height: controller.document.canvas.height }),
      visible: () => {
        const r = rootRef.current?.getBoundingClientRect();
        return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
      },
      toViewport: (p) => docToClient(p) ?? p,
      fromViewport: (p) => clientToDoc(p) ?? p,
      reveal: () => onPlaybackReveal?.(),
    },
    presence ?? ownPresence,
  );
  /** Document pixels → pixels in the editor's root, for the cursor layer. */
  const docToRoot = (p: PlaybackPoint): PlaybackPoint => {
    const c = docToClient(p);
    const box = rootRef.current?.getBoundingClientRect();
    return c && box ? { x: c.x - box.left, y: c.y - box.top } : p;
  };
  const [error, setError] = useState<string | null>(null);
  const effects = usePaintEffectsProvider(controller);
  const tabs: SideTab[] = effects ? ['color', 'wet', 'paper', 'layers', 'effects'] : ['color', 'wet', 'paper', 'layers'];
  return (
    <div ref={rootRef} className={`relative flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2 ${className ?? ''}`} style={{ height }} data-testid="paint-editor">
      {playing && <PresenceLayer presence={agentPresence} viewport={docToRoot} />}
      <PaintToolbar controller={controller} tool={tool} onToolChange={setTool} fileName={fileName} />
      <div className="flex min-h-0 flex-1 gap-2">
        <BrushPanel controller={controller} className="w-60 shrink-0 overflow-y-auto pr-1" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* With playback the editor draws the cursor (over the panels too), so the canvas doesn't. */}
          <PaintCanvas controller={controller} tool={tool} onError={setError} presence={playing ? undefined : presence} className="flex-1 rounded-lg" />
          {error && (
            <p role="alert" className="mt-1 text-[11px] text-rose-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto pr-1">
          <div className="flex gap-1" role="tablist" aria-label="Paint panels">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-paint-tab={t} className={chip(tab === t)} onClick={() => setTab(t)}>
                {t === 'color' ? 'Colour' : t === 'wet' ? 'Wet' : t === 'paper' ? 'Paper' : t === 'layers' ? 'Layers' : 'Effects'}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2" data-paint-panel={tab}>
            {tab === 'color' && <ColorPanel controller={controller} />}
            {tab === 'wet' && <WetPanel controller={controller} />}
            {tab === 'paper' && <PaperPanel controller={controller} />}
            {tab === 'layers' && <PaintLayersPanel controller={controller} />}
            {tab === 'layers' && <StickerPanel controller={controller} />}
            {tab === 'effects' && effects && <PaintEffectsPanel controller={controller} />}
          </div>
        </div>
      </div>
    </div>
  );
};
