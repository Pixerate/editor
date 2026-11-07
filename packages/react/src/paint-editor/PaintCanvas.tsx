import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  PaintCanvasPresenter,
  PaintGesture,
  documentToScreen,
  screenToDocument,
  drawWaterOverlay,
  startDeviceTilt,
  startWetClock,
  fitZoom,
  guideOverlay,
  handlePaintShortcut,
  viewCssTransform,
  type PaintEditorController,
  paintAgentStrokePoints,
  paintProposalGhost,
  type PaintAgentStrokes,
  type FillRegionOptions,
  type PaintPresence,
  type PaintProposal,
  type PaintProposals,
  type PaintTool,
  type PaintView,
} from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';

export interface PaintCanvasProps {
  controller: PaintEditorController;
  /** The active tool (default brush). */
  tool?: PaintTool;
  /** Options for the Fill tool (`tool === 'fill'`). */
  fillOptions?: Omit<FillRegionOptions, 'x' | 'y' | 'points'>;
  /** Draw the symmetry axes and perspective lines (default true). */
  showGuides?: boolean;
  /** Fit the canvas in the viewport on mount (default true). */
  fitOnMount?: boolean;
  /** Called with a refusal (hidden or locked layer). */
  onError?: (message: string | null) => void;
  /** Agent cursors to draw over the canvas (see `PaintDirector` and `usePaintDirector`). */
  presence?: PaintPresence;
  /** Paint an agent suggests, drawn over the canvas as ghosts (see `usePaintProposals`). */
  proposals?: PaintProposals;
  /** Strokes an agent is painting live alongside the user's, drawn as soft lines (see `createPaintAgentStrokes`). */
  agentStrokes?: PaintAgentStrokes;
  /** Follow device orientation (gyroscope tilt on iPhone and iPad) for thin-film iridescence view tilt. */
  deviceTilt?: boolean;
  className?: string;
}

/**
 * The painting surface: a document-sized canvas the compositor draws into (only changed tiles are
 * uploaded), shown through the view's zoom, pan, rotation and mirroring as a CSS transform (the
 * pixels never resample). Pointer input goes through `PaintGesture`: coalesced samples, a predicted
 * tail drawn as a thin preview, palm rejection, middle-button pan, wheel zoom and Shift+wheel
 * rotation. Guides and floating reference images are drawn on top.
 */
export const PaintCanvas: React.FC<PaintCanvasProps> = ({ controller, tool = 'brush', fillOptions, showGuides = true, fitOnMount = true, onError, presence, proposals, agentStrokes, deviceTilt = false, className }) => {
  const state = usePaintEditorState(controller);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const water = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const measured = useRef(false);
  const [predicted, setPredicted] = useState<Array<{ x: number; y: number }>>([]);
  const [strokeDrag, setStrokeDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const magnetDrag = useRef<{ id: string; moved: boolean } | null>(null);
  const presenter = useMemo(() => new PaintCanvasPresenter(controller), [controller]);
  const gesture = useMemo(
    () =>
      new PaintGesture(controller, () => {
        const r = viewport.current?.getBoundingClientRect();
        return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width || size.width, height: r?.height || size.height };
      }),
    // The box reads the element when called; `size` is only the jsdom fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller]
  );
  gesture.tool = tool;
  if (fillOptions) gesture.fillOptions = fillOptions;
  const { canvas: doc } = state.document;

  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return;
      measured.current = true;
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit once per canvas size, after the viewport has been measured (or at once where it cannot be).
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const key = `${doc.width}x${doc.height}`;
    if (!fitOnMount || fitted.current === key) return;
    if (typeof ResizeObserver !== 'undefined' && !measured.current) return;
    fitted.current = key;
    controller.setView({ zoom: fitZoom(doc, size), pan: { x: 0, y: 0 } });
  }, [controller, doc, size, fitOnMount]);

  // Upload changed tiles whenever the state changes.
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx && typeof ctx.createImageData === 'function') presenter.render(ctx as never);
    else controller.takeDirty();
  }, [state, presenter, controller]);

  // Wet paint flows with the display.
  useEffect(() => startWetClock(controller), [controller]);

  // Device orientation shifts viewTilt when opted in.
  useEffect(() => (deviceTilt ? startDeviceTilt(controller) : undefined), [controller, deviceTilt]);

  // The water overlay.
  useEffect(() => {
    const ctx = water.current?.getContext('2d');
    if (ctx && typeof ctx.createImageData === 'function') drawWaterOverlay(controller, ctx as never);
  }, [state, controller]);

  // Live effect paint plays while the canvas is mounted (idle when nothing is live or it is paused).
  useEffect(() => {
    const player = controller.playEffects();
    return () => player.stop();
  }, [controller]);

  // Wheel needs a non-passive listener to prevent page scroll (see GOTCHAS).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      gesture.wheel(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [gesture]);

  const report = () => onError?.(gesture.error);
  const transform = viewCssTransform(state.view, doc, size);
  const lines = showGuides ? guideOverlay(controller, strokeDrag) : [];

  return (
    <div
      ref={viewport}
      tabIndex={0}
      role="application"
      aria-label="Paint canvas"
      data-testid="paint-canvas"
      className={`relative overflow-hidden bg-slate-950 outline-none touch-none select-none ${className ?? ''}`}
      style={{ cursor: tool === 'pan' ? 'grab' : tool === 'eyedropper' ? 'copy' : tool === 'stroke' ? 'default' : 'crosshair' }}
      onPointerDown={(e) => {
        viewport.current?.focus();
        if (gesture.down(e.nativeEvent)) (e.target as Element).setPointerCapture?.(e.pointerId);
        report();
      }}
      onPointerMove={(e) => {
        gesture.move(e.nativeEvent);
        if (gesture.predicted.length || predicted.length) setPredicted(gesture.predicted.map((p) => ({ x: p.x, y: p.y })));
        if (gesture.strokeDrag || strokeDrag) setStrokeDrag(gesture.strokeDrag);
      }}
      onPointerUp={(e) => {
        gesture.up(e.nativeEvent);
        setPredicted([]);
        setStrokeDrag(null);
        report();
      }}
      onPointerCancel={() => {
        gesture.cancel();
        setPredicted([]);
        setStrokeDrag(null);
      }}
      onKeyDown={(e) => {
        if (handlePaintShortcut(controller, gesture, e)) e.preventDefault();
      }}
    >
      <canvas
        ref={canvas}
        width={doc.width}
        height={doc.height}
        className="absolute left-0 top-0 shadow-2xl"
        style={{ transform, transformOrigin: '0 0', imageRendering: state.view.zoom > 2 ? 'pixelated' : 'auto' }}
      />
      {state.wet.overlay && (
        <canvas
          ref={water}
          width={doc.width}
          height={doc.height}
          data-testid="paint-water-overlay"
          className="absolute left-0 top-0 pointer-events-none opacity-60"
          style={{ transform, transformOrigin: '0 0' }}
        />
      )}
      <svg className="absolute left-0 top-0 pointer-events-none overflow-visible" width={doc.width} height={doc.height} style={{ transform, transformOrigin: '0 0' }} aria-hidden="true">
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.from.x}
            y1={l.from.y}
            x2={l.to.x}
            y2={l.to.y}
            stroke={l.kind === 'symmetry' ? '#22d3ee' : l.kind === 'stencil' ? '#fbbf24' : l.kind === 'stroke' || l.kind === 'sticker' ? '#818cf8' : '#f472b6'}
            strokeOpacity={l.kind === 'symmetry' || l.kind === 'stencil' || l.kind === 'stroke' || l.kind === 'sticker' ? 0.8 : 0.35}
            strokeWidth={1 / state.view.zoom}
            strokeDasharray={l.kind === 'symmetry' ? `${6 / state.view.zoom} ${4 / state.view.zoom}` : undefined}
          />
        ))}
        {agentStrokes && <PaintAgentStrokeLines strokes={agentStrokes} />}
        {predicted.length > 0 && (
          <polyline points={predicted.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={state.color} strokeOpacity={0.5} strokeWidth={Math.max(1, state.brush.tip.size / 2)} strokeLinecap="round" />
        )}
      </svg>
      {state.guides.references
        .filter((r) => r.visible)
        .map((r) => (
          <ReferencePanel key={r.id} controller={controller} id={r.id} />
        ))}
      {showGuides &&
        (state.document.magnets ?? []).map((m) => {
          const p = documentToScreen(state.view, doc, size, m.x, m.y);
          return (
            <button
              key={m.id}
              type="button"
              aria-label={`Magnet ${m.id}`}
              data-testid={`paint-magnet-${m.id}`}
              data-magnet={m.id}
              title={`Magnet ${m.id} (${Math.round(m.x)}, ${Math.round(m.y)})`}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full border border-indigo-300 bg-slate-900/90 text-[9px] font-bold text-indigo-200 shadow cursor-move"
              style={{ left: p.x, top: p.y }}
              onPointerDown={(e) => {
                e.stopPropagation();
                magnetDrag.current = { id: m.id, moved: false };
                (e.target as Element).setPointerCapture?.(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = magnetDrag.current;
                if (!d || d.id !== m.id) return;
                e.stopPropagation();
                const r = viewport.current?.getBoundingClientRect();
                const box = { width: r?.width || size.width, height: r?.height || size.height };
                const pt = screenToDocument(state.view, doc, box, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
                controller.updateMagnet(m.id, { x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 }, !d.moved);
                d.moved = true;
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                magnetDrag.current = null;
              }}
              onPointerCancel={() => {
                magnetDrag.current = null;
              }}
            >
              {m.strength >= 0 ? 'N' : 'S'}
            </button>
          );
        })}
      {proposals && <PaintProposalGhosts proposals={proposals} transform={transform} zoom={state.view.zoom} />}
      {presence && <PaintPresenceLayer presence={presence} view={state.view} canvas={doc} viewport={size} />}
      <div className="absolute bottom-1 right-2 text-[10px] text-slate-500 pointer-events-none" data-testid="paint-view-status">
        {Math.round(state.view.zoom * 100)}% · {Math.round(state.view.rotation)}°{state.view.mirror ? ' · mirrored' : ''}
      </div>
    </div>
  );
};

/**
 * Agent cursors and notes over the canvas. Positions are document pixels, placed through the view
 * (zoom, pan, rotation, mirroring), while the cursors themselves stay upright and unscaled.
 */
export const PaintPresenceLayer: React.FC<{ presence: PaintPresence; view: PaintView; canvas: { width: number; height: number }; viewport: { width: number; height: number } }> = ({ presence, view, canvas, viewport }) => {
  const { actors } = useSyncExternalStore(presence.subscribe, presence.getState, presence.getState);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-paint-presence="" aria-hidden="true">
      {actors.map((a) => {
        const p = documentToScreen(view, canvas, viewport, a.x, a.y);
        return (
          <div key={a.id} className="absolute" style={{ left: p.x, top: p.y }} data-actor={a.id}>
            <svg width="18" height="20" viewBox="0 0 18 20" className="drop-shadow-md" style={{ transform: a.pressed ? 'scale(0.85)' : undefined, transformOrigin: '0 0' }}>
              <path d="M0 0 L0 15 L4.5 10.8 L7.6 17 L10.2 15.8 L7.2 9.7 L13.5 9.4 Z" fill={a.color} stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <span className="absolute left-4 top-4 w-max max-w-[240px] rounded-md px-2 py-0.5 text-[11px] font-semibold text-white shadow" style={{ background: a.color }}>
              {a.message ?? a.name}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** A floating reference image: drag its title bar to move it, click the image to pick a colour. */
const ReferencePanel: React.FC<{ controller: PaintEditorController; id: string }> = ({ controller, id }) => {
  const state = usePaintEditorState(controller);
  const ref = state.guides.references.find((r) => r.id === id);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  if (!ref) return null;
  const h = (ref.height / ref.width) * ref.displayWidth;
  return (
    <div
      className="absolute rounded border border-slate-700 bg-slate-900/95 shadow-xl"
      style={{ left: ref.x, top: ref.y, width: ref.displayWidth }}
      data-testid="paint-reference"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between px-1.5 py-0.5 text-[10px] text-slate-300 cursor-move"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, ox: ref.x, oy: ref.y };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) controller.updateReferenceImage(id, { x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <span className="truncate">{ref.name}</span>
        <button type="button" aria-label={`Hide ${ref.name}`} className="px-1 text-slate-400 hover:text-white" onClick={() => controller.updateReferenceImage(id, { visible: false })}>
          ×
        </button>
      </div>
      <img
        src={ref.src}
        alt={ref.name}
        draggable={false}
        width={ref.displayWidth}
        height={h}
        className="block cursor-copy"
        onClick={(e) => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          const k = ref.width / (rect.width || ref.displayWidth);
          controller.setColor(controller.pickReferenceColor(id, Math.min(ref.width - 1, (e.clientX - rect.left) * k), Math.min(ref.height - 1, (e.clientY - rect.top) * k)));
        }}
      />
    </div>
  );
};

/** Pending paint proposals drawn over the canvas: each ghost where its paint would go, translucent with a dashed edge. */
export const PaintProposalGhosts: React.FC<{ proposals: PaintProposals; transform: string; zoom: number }> = ({ proposals, transform, zoom }) => {
  const { proposals: pending } = useSyncExternalStore(proposals.subscribe, proposals.getState, proposals.getState);
  return (
    <>
      {pending.map((p) => (
        <PaintProposalGhost key={p.id} proposal={p} transform={transform} zoom={zoom} />
      ))}
    </>
  );
};

const PaintProposalGhost: React.FC<{ proposal: PaintProposal; transform: string; zoom: number }> = ({ proposal, transform, zoom }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const ghost = paintProposalGhost(proposal);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || !ghost || typeof ImageData === 'undefined') return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(ghost.data), ghost.width, ghost.height), 0, 0);
  }, [ghost?.data]);
  if (!ghost) return null;
  return (
    <canvas
      ref={ref}
      width={ghost.width}
      height={ghost.height}
      data-paint-proposal={proposal.id}
      title={proposal.rationale ? `${proposal.title}: ${proposal.rationale}` : proposal.title}
      aria-label={`Suggested: ${proposal.title}`}
      className="absolute left-0 top-0 pointer-events-none"
      style={{ transform: `${transform} translate(${ghost.x}px, ${ghost.y}px)`, transformOrigin: '0 0', opacity: 0.7, outline: `${1.5 / zoom}px dashed #a78bfa`, outlineOffset: `${2 / zoom}px` }}
    />
  );
};

/** Live agent strokes as soft round-capped lines, in document coordinates (inside the canvas's SVG overlay). */
const PaintAgentStrokeLines: React.FC<{ strokes: PaintAgentStrokes }> = ({ strokes }) => {
  const { strokes: list } = useSyncExternalStore(strokes.subscribe, strokes.getState, strokes.getState);
  return (
    <>
      {list.map((s) => (
        <polyline key={s.id} data-agent-stroke={s.id} points={paintAgentStrokePoints(s)} fill="none" stroke={s.color} strokeOpacity={s.opacity ?? 0.6} strokeWidth={s.size} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </>
  );
};
