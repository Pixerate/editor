import React, { useRef } from 'react';
import { PAINT_TOOLS, SYMMETRY_MODES, decodeImageBlob, downloadBytes, type PaintEditorController, type PaintTool, type SymmetryMode } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, button, chip, useAttempt } from './shared';

export interface PaintToolbarProps {
  controller: PaintEditorController;
  tool: PaintTool;
  onToolChange: (tool: PaintTool) => void;
  /** Base name of saved and exported files (default `painting`). */
  fileName?: string;
  className?: string;
}

/**
 * Tools (brush, eyedropper, pan, rotate view), undo / redo, view rotation, mirroring and reset,
 * the symmetry and perspective guides, the tracing image and reference images, the drawing hand,
 * and file actions: save / open JSON, export PNG, JPEG and PSD.
 */
export const PaintToolbar: React.FC<PaintToolbarProps> = ({ controller, tool, onToolChange, fileName = 'painting', className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const openRef = useRef<HTMLInputElement>(null);
  const tracingRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const { symmetry, perspective, tracing } = state.guides;
  const { canvas } = state.document;

  const exportImage = (format: 'image/png' | 'image/jpeg') =>
    attempt(async () => downloadBytes(await controller.exportImage({ format }), `${fileName}.${format === 'image/png' ? 'png' : 'jpg'}`, format));

  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs text-slate-200 ${className ?? ''}`} role="toolbar" aria-label="Paint toolbar" data-testid="paint-toolbar">
      {PAINT_TOOLS.map((t) => (
        <button key={t.id} type="button" aria-pressed={tool === t.id} title={`${t.label} (${t.key.toUpperCase()})`} className={chip(tool === t.id)} onClick={() => onToolChange(t.id)}>
          {t.label}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <button type="button" className={button} disabled={!state.canUndo} title={state.undoLabel ? `Undo ${state.undoLabel}` : 'Undo'} onClick={() => controller.undo()}>
        Undo
      </button>
      <button type="button" className={button} disabled={!state.canRedo} title={state.redoLabel ? `Redo ${state.redoLabel}` : 'Redo'} onClick={() => controller.redo()}>
        Redo
      </button>
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <button type="button" className={button} aria-label="Rotate view left" onClick={() => controller.setView({ rotation: state.view.rotation - 15 })}>
        ⟲
      </button>
      <button type="button" className={button} aria-label="Rotate view right" onClick={() => controller.setView({ rotation: state.view.rotation + 15 })}>
        ⟳
      </button>
      <button type="button" className={chip(state.view.mirror)} aria-pressed={state.view.mirror} onClick={() => controller.setView({ mirror: !state.view.mirror })}>
        Mirror view
      </button>
      <button type="button" className={button} onClick={() => controller.resetView()}>
        Reset view
      </button>
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <label className="flex items-center gap-1">
        Symmetry
        <select
          aria-label="Symmetry"
          value={symmetry.mode}
          onChange={(e) => controller.setSymmetry({ mode: e.target.value as SymmetryMode, center: symmetry.mode === 'off' ? { x: canvas.width / 2, y: canvas.height / 2 } : symmetry.center })}
          className="rounded bg-slate-800 px-1 py-0.5"
        >
          {SYMMETRY_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {symmetry.mode === 'kaleidoscope' && (
        <input
          type="number"
          aria-label="Kaleidoscope segments"
          min={2}
          max={32}
          value={symmetry.segments}
          onChange={(e) => controller.setSymmetry({ segments: Number(e.target.value) })}
          className="w-12 rounded bg-slate-800 px-1 py-0.5"
        />
      )}
      <button
        type="button"
        className={chip(perspective.enabled)}
        aria-pressed={perspective.enabled}
        onClick={() =>
          attempt(() =>
            controller.setPerspective(
              perspective.enabled ? { enabled: false } : { enabled: true, points: perspective.points.length ? perspective.points : [{ x: canvas.width / 2, y: canvas.height * 0.4 }] }
            )
          )
        }
      >
        Perspective
      </button>
      {perspective.enabled && (
        <select
          aria-label="Vanishing points"
          value={perspective.points.length}
          onChange={(e) => {
            const n = Number(e.target.value);
            const y = canvas.height * 0.4;
            const pts = n === 1 ? [{ x: canvas.width / 2, y }] : n === 2 ? [{ x: -canvas.width * 0.5, y }, { x: canvas.width * 1.5, y }] : [{ x: -canvas.width * 0.5, y }, { x: canvas.width * 1.5, y }, { x: canvas.width / 2, y: canvas.height * 3 }];
            attempt(() => controller.setPerspective({ points: pts }));
          }}
          className="rounded bg-slate-800 px-1 py-0.5"
        >
          <option value={1}>1-point</option>
          <option value={2}>2-point</option>
          <option value={3}>3-point</option>
        </select>
      )}
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <button type="button" className={button} onClick={() => tracingRef.current?.click()}>
        Tracing image…
      </button>
      {tracing && (
        <>
          <input
            type="range"
            aria-label="Tracing opacity"
            min={0}
            max={1}
            step={0.05}
            value={tracing.opacity}
            onChange={(e) => controller.updateTracing({ opacity: Number(e.target.value) })}
            className="w-16 accent-indigo-500"
          />
          <button type="button" className={chip(tracing.sampleColors)} aria-pressed={tracing.sampleColors} onClick={() => controller.updateTracing({ sampleColors: !tracing.sampleColors })}>
            Trace colours
          </button>
          <button type="button" className={chip(tracing.visible)} aria-pressed={tracing.visible} onClick={() => controller.updateTracing({ visible: !tracing.visible })}>
            Show tracing
          </button>
          <button type="button" className={button} onClick={() => controller.clearTracingImage()}>
            Remove tracing
          </button>
        </>
      )}
      <button type="button" className={button} onClick={() => refRef.current?.click()}>
        Reference…
      </button>
      <button type="button" className={button} title="Which hand holds the pen (palm rejection)" onClick={() => controller.setHand(state.hand === 'right' ? 'left' : 'right')}>
        {state.hand === 'right' ? 'Right-handed' : 'Left-handed'}
      </button>
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <button type="button" className={button} onClick={() => attempt(() => downloadBytes(JSON.stringify(controller.toJSON()), `${fileName}.paint.json`, 'application/json'))}>
        Save
      </button>
      <button type="button" className={button} onClick={() => openRef.current?.click()}>
        Open…
      </button>
      <button type="button" className={button} onClick={() => exportImage('image/png')}>
        PNG
      </button>
      <button type="button" className={button} onClick={() => exportImage('image/jpeg')}>
        JPEG
      </button>
      <button type="button" className={button} onClick={() => attempt(() => downloadBytes(controller.exportPsd().bytes, `${fileName}.psd`, 'image/vnd.adobe.photoshop'))}>
        PSD
      </button>
      <input
        ref={openRef}
        type="file"
        accept=".json,application/json"
        aria-label="Open painting"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attempt(async () => controller.loadJSON(JSON.parse(await f.text())));
          e.target.value = '';
        }}
      />
      <input
        ref={tracingRef}
        type="file"
        accept="image/*"
        aria-label="Load tracing image"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attempt(async () => controller.setTracingImage({ pixels: await decodeImageBlob(f) }));
          e.target.value = '';
        }}
      />
      <input
        ref={refRef}
        type="file"
        accept="image/*"
        aria-label="Add reference image"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attempt(async () => controller.addReferenceImage({ pixels: await decodeImageBlob(f), name: f.name }));
          e.target.value = '';
        }}
      />
      <ErrorLine error={error} />
    </div>
  );
};
