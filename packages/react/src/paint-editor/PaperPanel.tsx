import React, { useMemo } from 'react';
import { PAPER_FAMILIES, PAPER_LIBRARY, PAPER_SLIDERS, patchPath, readPath, renderPaper, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { CommitColorInput, ErrorLine, PaintSlider, PixelCanvas, panel, useAttempt } from './shared';

export interface PaperPanelProps {
  controller: PaintEditorController;
  className?: string;
}

const SWATCH = { x: 0, y: 0, width: 64, height: 40 };

/**
 * The paper library by family (each a generated grain preview) and the current paper's colour,
 * grain depth, scale, shading and contrast, plus the wet-media properties stored for later.
 * Each change is one undo step (sliders commit on release).
 */
export const PaperPanel: React.FC<PaperPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const paper = state.document.paper;
  const previews = useMemo(() => new Map(PAPER_LIBRARY.map((p) => [p.preset, { ...SWATCH, data: renderPaper({ ...p, shading: Math.max(0.8, p.shading) }, SWATCH) }])), []);

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="paper-panel">
      {PAPER_FAMILIES.map((family) => (
        <div key={family}>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">{family}</div>
          <div className="flex flex-wrap gap-1" role="listbox" aria-label={`${family} papers`}>
            {PAPER_LIBRARY.filter((p) => p.family === family).map((p) => (
              <button
                key={p.preset}
                type="button"
                role="option"
                aria-selected={paper.preset === p.preset}
                title={p.name}
                className={`rounded p-0.5 ${paper.preset === p.preset ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-700 hover:ring-slate-500'}`}
                onClick={() => attempt(() => controller.setPaper({ preset: p.preset }))}
              >
                <PixelCanvas pixels={previews.get(p.preset) ?? null} label={p.name} style={{ width: 48, height: 30 }} />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="text-slate-300">{paper.name}</div>
      <label className="flex items-center justify-between">
        <span className="text-slate-400">Colour</span>
        <CommitColorInput label="Paper colour" value={paper.color} onCommit={(v) => attempt(() => controller.setPaper({ color: v }))} className="h-6 w-10 rounded bg-transparent" />
      </label>
      {PAPER_SLIDERS.map((c) => (
        <PaintSlider key={c.path} control={c} value={readPath(paper, c.path)} onCommit={(v) => attempt(() => controller.setPaper(patchPath(paper as never, c.path, v) as never))} />
      ))}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={paper.tiling === 'mirror'} onChange={(e) => attempt(() => controller.setPaper({ tiling: e.target.checked ? 'mirror' : 'repeat' }))} /> Mirror tiling
      </label>
      <button type="button" className="self-start px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => attempt(() => controller.setPaper({ seed: paper.seed + 1 }))}>
        New sheet
      </button>
      <ErrorLine error={error} />
    </div>
  );
};
