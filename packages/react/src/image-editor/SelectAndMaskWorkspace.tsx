import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageEditorController, RefineOutput, RefineOutputResult, SelectAndMaskSettings, SelectAndMaskView } from '@pixerate/editor/image-editor';
import { REFINE_EDGE_CONTROLS, REFINE_OUTPUTS, SELECT_AND_MASK_TOOLS, SELECT_AND_MASK_VIEWS, SelectAndMaskSession } from '@pixerate/editor/image-editor';
import { imageSectionTitleClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';

export interface SelectAndMaskWorkspaceProps {
  controller: ImageEditorController;
  /** Called with the result after OK, or `null` after Cancel. */
  onClose: (result: RefineOutputResult | null) => void;
  className?: string;
}

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
const toggle = (on: boolean) => `${button} ${on ? 'bg-primary text-primary-foreground border-primary' : ''}`;

/**
 * Select and Mask: a full-window workspace over the editor with its own tools (Quick Selection,
 * Refine Edge Brush, Brush, Object Selection, Lasso, Hand, Zoom), view modes, edge and output
 * settings, and a live preview. OK applies everything as one undo step, the same
 * `refineSelectionTo` call an agent makes; Cancel leaves the document as it was. Keys as in
 * Photoshop (see `SelectAndMaskSession.handleKey`), plus Enter (OK), Escape (Cancel) and Ctrl/⌘+Z
 * (undo the last stroke).
 */
export const SelectAndMaskWorkspace: React.FC<SelectAndMaskWorkspaceProps> = ({ controller, onClose, className = '' }) => {
  const session = useMemo(() => new SelectAndMaskSession(controller), [controller]);
  const [, setRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panFrom = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const settings = session.settings;
  const size = session.previewSize;

  useEffect(() => {
    const off = session.subscribe(() => setRevision(session.revision));
    void session.open();
    return () => {
      off();
    };
  }, [session]);

  // Draw the preview whenever it changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx || !size.width || typeof ImageData === 'undefined') return;
    canvas.width = size.width;
    canvas.height = size.height;
    ctx.putImageData(new ImageData(session.render() as Uint8ClampedArray<ArrayBuffer>, size.width, size.height), 0, 0);
  });

  const set = (changes: Partial<SelectAndMaskSettings>) => session.update(changes);

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
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') session.undoEdit();
      else if (e.ctrlKey || e.metaKey || e.altKey || !session.handleKey(e.key)) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** The pointer's position in natural image pixels. */
  const toImage = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const naturalW = size.width / size.scale;
    const naturalH = size.height / size.scale;
    return { x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * naturalW, y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * naturalH };
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

  const toLayer = settings.output === 'new-layer' || settings.output === 'new-layer-with-mask';
  const brushTool = settings.tool === 'quick-select' || settings.tool === 'brush' || settings.tool === 'refine-brush';

  return (
    <div
      data-testid="select-and-mask-workspace"
      role="dialog"
      aria-label="Select and Mask"
      className={`fixed inset-0 z-50 flex bg-background text-xs text-foreground ${className}`}
    >
      <div role="group" aria-label="Select and Mask tool" className="flex flex-col gap-1 p-2 border-r border-border">
        {SELECT_AND_MASK_TOOLS.map((t) => (
          <button key={t.id} type="button" title={`${t.label} (${t.key.toUpperCase()})`} aria-pressed={settings.tool === t.id} className={toggle(settings.tool === t.id)} onClick={() => set({ tool: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-wrap items-center gap-2 p-2 border-b border-border">
          {brushTool && (
            <label className="flex items-center gap-1 text-muted-foreground">
              Size
              <input
                type="number"
                min={1}
                aria-label="Brush size"
                value={settings.brushSize}
                onChange={(e) => set({ brushSize: Math.max(1, Number(e.target.value) || 1) })}
                className="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
              />
              px
            </label>
          )}
          {settings.tool !== 'refine-brush' && settings.tool !== 'hand' && settings.tool !== 'zoom' && (
            <div role="group" aria-label="Stroke mode" className="flex gap-1">
              <button type="button" aria-pressed={settings.brushMode === 'add'} className={toggle(settings.brushMode === 'add')} onClick={() => set({ brushMode: 'add' })}>
                Add
              </button>
              <button type="button" aria-pressed={settings.brushMode === 'subtract'} className={toggle(settings.brushMode === 'subtract')} onClick={() => set({ brushMode: 'subtract' })}>
                Subtract
              </button>
            </div>
          )}
          <span className="text-muted-foreground">{session.edits.length} strokes</span>
          <button type="button" className={button} disabled={!session.edits.length} onClick={() => session.undoEdit()}>
            Undo Stroke
          </button>
          <span className="font-mono text-muted-foreground">{Math.round(zoom * 100)}%</span>
        </div>
        <div className="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
          <canvas
            ref={canvasRef}
            data-testid="select-and-mask-preview"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            style={{
              // Fitted to the area at its own aspect ratio; zoom and pan are a transform.
              maxWidth: '100%',
              maxHeight: '100%',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              imageRendering: zoom > 2 ? 'pixelated' : undefined,
              cursor: settings.tool === 'hand' ? 'grab' : settings.tool === 'zoom' ? 'zoom-in' : 'crosshair',
            }}
          />
        </div>
      </div>
      <div className="w-64 flex flex-col gap-3 p-3 border-l border-border overflow-y-auto">
        <span className={imageSectionTitleClass}>View Mode</span>
        <label className="flex items-center gap-2">
          View
          <ImageSelect
            label="View"
            value={settings.view}
            options={SELECT_AND_MASK_VIEWS.map((v) => ({ value: v.id, label: `${v.label} (${v.key.toUpperCase()})` }))}
            onChange={(v) => set({ view: v as SelectAndMaskView })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-muted-foreground">
            <span>Opacity</span>
            <span className="font-mono">{Math.round(settings.opacity * 100)}%</span>
          </span>
          <ImageRange label="View opacity" min={0} max={100} step={1} value={Math.round(settings.opacity * 100)} onChange={(v) => set({ opacity: v / 100 })} />
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Show Edge" checked={settings.showEdge} onChange={(on) => set({ showEdge: on })} />
          Show Edge (J)
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Show Original" checked={settings.showOriginal} onChange={(on) => set({ showOriginal: on })} />
          Show Original (P)
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Real-Time Refinement" checked={settings.realTime} onChange={(on) => set({ realTime: on })} />
          Real-Time Refinement
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="High Quality Preview" checked={settings.highQuality} onChange={(on) => set({ highQuality: on })} />
          High Quality Preview
        </label>

        <span className={imageSectionTitleClass}>Edge Detection and Refinement</span>
        {controller.segmentationProvider && (
          <label className="flex items-center gap-2">
            Mode
            <ImageSelect
              label="Refine mode"
              value={settings.refineMode}
              options={[
                { value: 'color', label: 'Color Aware' },
                { value: 'object', label: 'Object Aware' },
              ]}
              onChange={(v) => set({ refineMode: v as 'color' | 'object' })}
            />
          </label>
        )}
        {REFINE_EDGE_CONTROLS.map((c) => (
          <label key={c.id} className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>{c.label}</span>
              <span className="font-mono">
                {settings.params[c.id]}
                {c.unit}
              </span>
            </span>
            <ImageRange label={`Workspace ${c.label}`} min={c.min} max={c.max} step={c.step} value={settings.params[c.id]} onChange={(v) => set({ params: { ...settings.params, [c.id]: v } })} />
          </label>
        ))}
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Workspace Smart Radius" checked={settings.params.smartRadius} onChange={(on) => set({ params: { ...settings.params, smartRadius: on } })} />
          Smart Radius
        </label>

        <span className={imageSectionTitleClass}>Output Settings</span>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-muted-foreground">
            <span>Decontaminate Colors{toLayer ? '' : ' (new layer outputs)'}</span>
            <span className="font-mono">{settings.decontaminate}%</span>
          </span>
          <ImageRange label="Workspace decontaminate amount" min={0} max={100} step={1} value={settings.decontaminate} disabled={!toLayer} onChange={(v) => set({ decontaminate: v })} />
        </label>
        <label className="flex items-center gap-2">
          Output To
          <ImageSelect
            label="Output to"
            value={settings.output}
            options={REFINE_OUTPUTS.map((o) => ({ value: o.id, label: o.label }))}
            onChange={(v) => set({ output: v as RefineOutput })}
          />
        </label>
        <label className="flex items-center gap-2">
          <ImageCheckbox label="Remember Settings" checked={settings.remember} onChange={(on) => set({ remember: on })} />
          Remember Settings
        </label>
        {(error ?? session.error) && (
          <p role="alert" className="text-destructive">
            {error ?? session.error}
          </p>
        )}
        {session.note && <p className="text-muted-foreground">{session.note}</p>}
        <div className="flex gap-1 mt-auto">
          <button type="button" className={button} onClick={() => session.reset()}>
            Reset
          </button>
          <button type="button" className={button} onClick={() => onClose(null)}>
            Cancel
          </button>
          <button type="button" className={toggle(true)} disabled={busy} aria-busy={busy} onClick={() => void ok()}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
