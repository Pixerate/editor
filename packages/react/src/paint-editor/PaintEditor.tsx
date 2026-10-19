import React, { useState } from 'react';
import type { PaintEditorController, PaintPresence, PaintTool } from '@pixerate/editor/paint-editor';
import { BrushPanel } from './BrushPanel';
import { ColorPanel } from './ColorPanel';
import { PaintCanvas } from './PaintCanvas';
import { PaintLayersPanel } from './PaintLayersPanel';
import { PaintToolbar } from './PaintToolbar';
import { PaperPanel } from './PaperPanel';
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
}

type SideTab = 'color' | 'paper' | 'layers';

/**
 * The paint editor: toolbar, brush library on the left, the canvas, and colour (wheel,
 * harmonies, swatches, mixing pad), paper and layers on the right.
 */
export const PaintEditor: React.FC<PaintEditorProps> = ({ controller, fileName, height = 720, presence, className }) => {
  const [tool, setTool] = useState<PaintTool>('brush');
  const [tab, setTab] = useState<SideTab>('color');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={`flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2 ${className ?? ''}`} style={{ height }} data-testid="paint-editor">
      <PaintToolbar controller={controller} tool={tool} onToolChange={setTool} fileName={fileName} />
      <div className="flex min-h-0 flex-1 gap-2">
        <BrushPanel controller={controller} className="w-60 shrink-0 overflow-y-auto pr-1" />
        <div className="flex min-w-0 flex-1 flex-col">
          <PaintCanvas controller={controller} tool={tool} onError={setError} presence={presence} className="flex-1 rounded-lg" />
          {error && (
            <p role="alert" className="mt-1 text-[11px] text-rose-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto pr-1">
          <div className="flex gap-1" role="tablist" aria-label="Paint panels">
            {(['color', 'paper', 'layers'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={chip(tab === t)} onClick={() => setTab(t)}>
                {t === 'color' ? 'Colour' : t === 'paper' ? 'Paper' : 'Layers'}
              </button>
            ))}
          </div>
          {tab === 'color' && <ColorPanel controller={controller} />}
          {tab === 'paper' && <PaperPanel controller={controller} />}
          {tab === 'layers' && <PaintLayersPanel controller={controller} />}
        </div>
      </div>
    </div>
  );
};
