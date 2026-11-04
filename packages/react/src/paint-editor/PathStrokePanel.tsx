import React, { useState } from 'react';
import { PATH_STROKE_TAPERS, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, button, panel, useAttempt } from './shared';

export interface PathStrokePanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * Brush a path: paste SVG path data (document pixels, e.g. from a vector tool) and brush it on
 * the active layer with the active brush and colour, as if drawn by hand along it, with an even
 * pressure or a taper. One undo step, as the `stroke_path` agent tool.
 */
export const PathStrokePanel: React.FC<PathStrokePanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [path, setPath] = useState('');
  const [taper, setTaper] = useState(PATH_STROKE_TAPERS[0].id);
  const pressure = PATH_STROKE_TAPERS.find((t) => t.id === taper)?.pressure;
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="path-stroke-panel">
      <span className="font-medium text-slate-300">Brush a path</span>
      <textarea
        aria-label="SVG path data"
        placeholder="M 40 200 C 120 40 280 40 360 200"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        rows={2}
        className="w-full resize-y rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px]"
      />
      <div className="flex items-center gap-2">
        <select aria-label="Pressure along the path" value={taper} onChange={(e) => setTaper(e.target.value)} className="rounded bg-slate-800 px-1 py-0.5">
          {PATH_STROKE_TAPERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="button" className={button} disabled={!path.trim() || state.stroking} onClick={() => attempt(() => controller.strokePath({ path, ...(pressure ? { pressure } : {}) }))}>
          Brush path
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
};
