import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PaintCanvasPresenter,
  PaintGesture,
  fitZoom,
  guideOverlay,
  handlePaintShortcut,
  viewCssTransform,
  type PaintEditorController,
  type PaintTool,
} from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';

export interface PaintCanvasProps {
  controller: PaintEditorController;
  /** The active tool (default brush). */
  tool?: PaintTool;
  /** Draw the symmetry axes and perspective lines (default true). */
  showGuides?: boolean;
  /** Fit the canvas in the viewport on mount (default true). */
  fitOnMount?: boolean;
  /** Called with a refusal (hidden or locked layer). */
  onError?: (message: string | null) => void;
  className?: string;
}

/**
 * The painting surface: a document-sized canvas the compositor draws into (only changed tiles are
 * uploaded), shown through the view's zoom, pan, rotation and mirroring as a CSS transform (the
 * pixels never resample). Pointer input goes through `PaintGesture`: coalesced samples, a predicted
 * tail drawn as a thin preview, palm rejection, middle-button pan, wheel zoom and Shift+wheel
 * rotation. Guides and floating reference images are drawn on top.
 */
export const PaintCanvas: React.FC<PaintCanvasProps> = ({ controller, tool = 'brush', showGuides = true, fitOnMount = true, onError, className }) => {
  const state = usePaintEditorState(controller);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const measured = useRef(false);
  const [predicted, setPredicted] = useState<Array<{ x: number; y: number }>>([]);
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
  const lines = showGuides ? guideOverlay(controller) : [];

  return (
    <div
      ref={viewport}
      tabIndex={0}
      role="application"
      aria-label="Paint canvas"
      data-testid="paint-canvas"
      className={`relative overflow-hidden bg-slate-950 outline-none touch-none select-none ${className ?? ''}`}
      style={{ cursor: tool === 'pan' ? 'grab' : tool === 'eyedropper' ? 'copy' : 'crosshair' }}
      onPointerDown={(e) => {
        viewport.current?.focus();
        if (gesture.down(e.nativeEvent)) (e.target as Element).setPointerCapture?.(e.pointerId);
        report();
      }}
      onPointerMove={(e) => {
        gesture.move(e.nativeEvent);
        if (gesture.predicted.length || predicted.length) setPredicted(gesture.predicted.map((p) => ({ x: p.x, y: p.y })));
      }}
      onPointerUp={(e) => {
        gesture.up(e.nativeEvent);
        setPredicted([]);
      }}
      onPointerCancel={() => {
        gesture.cancel();
        setPredicted([]);
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
      <svg className="absolute left-0 top-0 pointer-events-none overflow-visible" width={doc.width} height={doc.height} style={{ transform, transformOrigin: '0 0' }} aria-hidden="true">
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.from.x}
            y1={l.from.y}
            x2={l.to.x}
            y2={l.to.y}
            stroke={l.kind === 'symmetry' ? '#22d3ee' : '#f472b6'}
            strokeOpacity={l.kind === 'symmetry' ? 0.8 : 0.35}
            strokeWidth={1 / state.view.zoom}
            strokeDasharray={l.kind === 'symmetry' ? `${6 / state.view.zoom} ${4 / state.view.zoom}` : undefined}
          />
        ))}
        {predicted.length > 0 && (
          <polyline points={predicted.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={state.color} strokeOpacity={0.5} strokeWidth={Math.max(1, state.brush.tip.size / 2)} strokeLinecap="round" />
        )}
      </svg>
      {state.guides.references
        .filter((r) => r.visible)
        .map((r) => (
          <ReferencePanel key={r.id} controller={controller} id={r.id} />
        ))}
      <div className="absolute bottom-1 right-2 text-[10px] text-slate-500 pointer-events-none" data-testid="paint-view-status">
        {Math.round(state.view.zoom * 100)}% · {Math.round(state.view.rotation)}°{state.view.mirror ? ' · mirrored' : ''}
      </div>
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
