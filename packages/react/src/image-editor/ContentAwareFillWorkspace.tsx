import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentAwareFillSettings, CropBox, ImageEditorController } from '@pixerate/editor/image-editor';
import { CONTENT_AWARE_FILL_SAMPLING, CONTENT_AWARE_FILL_TOOLS, ContentAwareFillSession } from '@pixerate/editor/image-editor';
import { imageSectionTitleClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';

export interface ContentAwareFillWorkspaceProps {
  controller: ImageEditorController;
  /** Called with the result after OK, or `null` after Cancel. */
  onClose: (result: { layerId: string; bounds: CropBox; output: 'current' | 'new-layer' | 'duplicate-layer' } | null) => void;
  className?: string;
}

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
const toggle = (on: boolean) => `${button} ${on ? 'bg-primary text-primary-foreground border-primary' : ''}`;

/**
 * Content-Aware Fill: a full-window workspace with the selection's surroundings on the left, the
 * sampling area (where the fill may copy from) shown in green and painted with the Sampling Brush
 * (Alt subtracts), and a live preview of the fill on the right. Seed, output and the sampling
 * presets (Auto, Rectangular, Custom) are in the panel. OK fills as one undo step, the same fill
 * the `content_aware_fill` tool makes; Cancel and Escape change nothing.
 */
export const ContentAwareFillWorkspace: React.FC<ContentAwareFillWorkspaceProps> = ({ controller, onClose, className = '' }) => {
  const session = useMemo(() => new ContentAwareFillSession(controller), [controller]);
  const [, setRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const panFrom = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const settings = session.settings;
  const win = session.window;

  useEffect(() => {
    const off = session.subscribe(() => setRevision(session.revision));
    void session.open();
    return () => {
      off();
    };
  }, [session]);

  // Draw both views whenever the session changes.
  useEffect(() => {
    if (!win || typeof ImageData === 'undefined') return;
    for (const [canvas, rgba] of [
      [sourceRef.current, session.renderSource()],
      [previewRef.current, session.renderPreview()],
    ] as const) {
      const ctx = canvas?.getContext?.('2d');
      if (!canvas || !ctx || !rgba.length) continue;
      canvas.width = win.width;
      canvas.height = win.height;
      ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, win.width, win.height), 0, 0);
    }
  });

  const set = (changes: Partial<ContentAwareFillSettings>) => session.update(changes);

  const ok = async () => {
    setBusy(true);
    setError(null);
    try {
      onClose(await session.commit());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') onClose(null);
      else if (e.key === 'Enter') void ok();
      else if (e.ctrlKey || e.metaKey || e.altKey || !session.handleKey(e.key)) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** The pointer's position in document pixels on the source view. */
  const toImage = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = win ?? { x: 0, y: 0, width: 1, height: 1 };
    return { x: w.x + ((e.clientX - rect.left) / Math.max(1, rect.width)) * w.width, y: w.y + ((e.clientY - rect.top) / Math.max(1, rect.height)) * w.height };
  };
  const onDown = (e: React.PointerEvent) => {
    if (settings.tool === 'hand') {
      panFrom.current = { x: e.clientX, y: e.clientY, pan };
      return;
    }
    if (settings.tool === 'zoom') {
      setZoom((z) => Math.min(16, Math.max(0.25, e.altKey ? z / 1.25 : z * 1.25)));
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    session.begin(toImage(e), { altKey: e.altKey });
  };
  const onMove = (e: React.PointerEvent) => {
    if (panFrom.current) {
      const p = panFrom.current;
      setPan({ x: p.pan.x + e.clientX - p.x, y: p.pan.y + e.clientY - p.y });
      return;
    }
    if (e.buttons) session.move(toImage(e));
  };
  const onUp = () => {
    panFrom.current = null;
    session.end();
  };
  const view: React.CSSProperties = { maxWidth: '100%', maxHeight: '100%', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, imageRendering: zoom > 2 ? 'pixelated' : undefined };

  return (
    <div data-testid="content-aware-fill-workspace" role="dialog" aria-label="Content-Aware Fill" className={`fixed inset-0 z-50 flex bg-background text-xs text-foreground ${className}`}>
      <div role="group" aria-label="Content-Aware Fill tool" className="flex flex-col gap-1 p-2 border-r border-border">
        {CONTENT_AWARE_FILL_TOOLS.map((t) => (
          <button key={t.id} type="button" title={`${t.label} (${t.key.toUpperCase()})`} aria-pressed={settings.tool === t.id} className={toggle(settings.tool === t.id)} onClick={() => set({ tool: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-wrap items-center gap-2 p-2 border-b border-border">
          {settings.tool === 'sampling-brush' && (
            <>
              <label className="flex items-center gap-1 text-muted-foreground">
                Size
                <input
                  type="number"
                  min={1}
                  aria-label="Sampling brush size"
                  value={settings.brushSize}
                  onChange={(e) => set({ brushSize: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
                />
                px
              </label>
              <div role="group" aria-label="Sampling brush mode" className="flex gap-1">
                <button type="button" aria-pressed={settings.brushMode === 'add'} className={toggle(settings.brushMode === 'add')} onClick={() => set({ brushMode: 'add' })}>
                  Add
                </button>
                <button type="button" aria-pressed={settings.brushMode === 'subtract'} className={toggle(settings.brushMode === 'subtract')} onClick={() => set({ brushMode: 'subtract' })}>
                  Subtract
                </button>
              </div>
            </>
          )}
          <span className="font-mono text-muted-foreground">{Math.round(zoom * 100)}%</span>
          {!session.showsWholeImage && (
            <button type="button" className={button} title="Show (and sample from) more of the image around the selection" onClick={() => session.expandView()}>
              Expand View
            </button>
          )}
          {session.computing && (
            <span role="status" className="text-muted-foreground">
              Updating preview…
            </span>
          )}
        </div>
        <div className="flex-1 grid grid-cols-2 gap-2 p-2 min-h-0">
          <div className="flex flex-col min-h-0">
            <span className="text-muted-foreground">Source (green: sampling area)</span>
            <div className="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
              <canvas
                ref={sourceRef}
                data-testid="content-aware-fill-source"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                style={{ ...view, cursor: settings.tool === 'hand' ? 'grab' : settings.tool === 'zoom' ? 'zoom-in' : 'crosshair' }}
              />
            </div>
          </div>
          <div className="flex flex-col min-h-0">
            <span className="text-muted-foreground">Preview</span>
            <div className="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
              <canvas ref={previewRef} data-testid="content-aware-fill-preview" style={view} />
            </div>
          </div>
        </div>
      </div>
      <div className="w-64 flex flex-col gap-3 p-3 border-l border-border overflow-y-auto">
        <span className={imageSectionTitleClass}>Sampling Area Options</span>
        <div role="group" aria-label="Sampling area" className="flex gap-1">
          {CONTENT_AWARE_FILL_SAMPLING.map((m) => (
            <button key={m.id} type="button" aria-pressed={settings.sampling === m.id} className={toggle(settings.sampling === m.id)} onClick={() => set({ sampling: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Show Sampling Area" checked={settings.showSampling} onChange={(on) => set({ showSampling: on })} />
          Show Sampling Area
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-muted-foreground">
            <span>Opacity</span>
            <span className="font-mono">{Math.round(settings.opacity * 100)}%</span>
          </span>
          <ImageRange label="Sampling overlay opacity" min={0} max={100} step={1} value={Math.round(settings.opacity * 100)} onChange={(v) => set({ opacity: v / 100 })} />
        </label>

        <span className={imageSectionTitleClass}>Fill Settings</span>
        <label className="flex items-center gap-2 text-muted-foreground">
          Seed
          <input
            type="number"
            min={0}
            aria-label="Fill seed"
            value={settings.seed}
            onChange={(e) => set({ seed: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            className="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
          <button type="button" className={button} onClick={() => set({ seed: settings.seed + 1 })}>
            Try Another
          </button>
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Live Preview" checked={settings.livePreview} onChange={(on) => set({ livePreview: on })} />
          Live Preview
        </label>
        {!settings.livePreview && (
          <button type="button" className={button} disabled={session.computing} onClick={() => void session.refresh()}>
            Preview
          </button>
        )}

        <span className={imageSectionTitleClass}>Output Settings</span>
        <label className="flex items-center gap-2">
          Output To
          <ImageSelect
            label="Fill output"
            value={settings.output}
            options={[
              { value: 'new-layer', label: 'New Layer' },
              { value: 'current', label: 'Current Layer' },
              { value: 'duplicate-layer', label: 'Duplicate Layer' },
            ]}
            onChange={(v) => set({ output: v as 'current' | 'new-layer' | 'duplicate-layer' })}
          />
        </label>
        {(error ?? session.error) && (
          <p role="alert" className="text-destructive">
            {error ?? session.error}
          </p>
        )}
        <div className="flex gap-1 mt-auto">
          <button type="button" className={button} onClick={() => session.reset()}>
            Reset
          </button>
          <button type="button" className={button} onClick={() => onClose(null)}>
            Cancel
          </button>
          <button type="button" className={toggle(true)} disabled={busy || !win} aria-busy={busy} onClick={() => void ok()}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
