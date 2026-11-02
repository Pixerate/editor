import React from 'react';
import { STROKE_SLIDERS, liveStrokeRefusal, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { CommitColorInput, ErrorLine, PaintSlider, button, panel, useAttempt } from './shared';

export interface StrokePanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * The active stroke layer's strokes: pick one (here, or with the Select stroke tool on the
 * canvas) to change its brush, size, opacity, flow, colour or seed, move it up or down, or delete
 * it. The layer redraws exactly; each change is one undo step. Shows nothing for other layers.
 */
export const StrokePanel: React.FC<StrokePanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const layerId = state.document.activeLayerId;
  const strokes = layerId ? state.document.liveStrokes?.[layerId] : undefined;
  if (!layerId || !strokes) return null;
  const index = strokes.findIndex((s) => s.id === state.selectedStroke);
  const sel = index >= 0 ? strokes[index] : null;
  const brushes = state.brushes.filter((b) => !liveStrokeRefusal(b));
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="stroke-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-300">Strokes ({strokes.length})</span>
        <button type="button" className={button} onClick={() => attempt(() => controller.rasterizeLiveStrokes(layerId))}>
          Rasterize
        </button>
      </div>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Strokes">
        {strokes.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={s.id === state.selectedStroke}
            title={`${i + 1}. ${s.brush.name} (${s.id})`}
            className={`h-5 w-5 rounded ring-1 ${s.id === state.selectedStroke ? 'ring-indigo-400' : 'ring-slate-700'}`}
            style={{ background: s.color }}
            onClick={() => controller.selectStroke(s.id)}
          />
        ))}
      </div>
      {sel && (
        <div className="flex flex-col gap-1.5" data-testid="stroke-edit">
          <label className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Brush</span>
            <select
              aria-label="Stroke brush"
              value={brushes.some((b) => b.id === sel.brush.id) ? sel.brush.id : ''}
              onChange={(e) => e.target.value && attempt(() => controller.updateStroke(sel.id, { brushId: e.target.value }))}
              className="max-w-[10rem] rounded bg-slate-800 px-1 py-0.5"
            >
              {!brushes.some((b) => b.id === sel.brush.id) && <option value="">{sel.brush.name}</option>}
              {brushes.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {STROKE_SLIDERS.map((c) => (
            <PaintSlider key={c.path} control={c} value={readPath(sel.brush, c.path)} onCommit={(v) => attempt(() => controller.updateStroke(sel.id, { brush: { tip: { [c.path.split('.')[1]]: v } } }))} />
          ))}
          <label className="flex items-center justify-between">
            <span className="text-slate-400">Colour</span>
            <CommitColorInput label="Stroke colour" value={sel.color} onCommit={(v) => attempt(() => controller.updateStroke(sel.id, { color: v }))} className="h-6 w-10 rounded bg-transparent" />
          </label>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={button} onClick={() => attempt(() => controller.updateStroke(sel.id, { seed: (sel.seed + 1) % 2147483647 }))}>
              New seed
            </button>
            <button type="button" className={button} disabled={index === strokes.length - 1} aria-label="Move stroke up" onClick={() => attempt(() => controller.reorderStroke(sel.id, index + 1))}>
              ↑
            </button>
            <button type="button" className={button} disabled={index === 0} aria-label="Move stroke down" onClick={() => attempt(() => controller.reorderStroke(sel.id, index - 1))}>
              ↓
            </button>
            <button type="button" className={button} onClick={() => attempt(() => (controller.removeStrokes([sel.id]), controller.selectStroke(null)))}>
              Delete
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
