import React, { useState } from 'react';
import { STAMP_KINDS, STAMP_LABELS, STICKER_SLIDERS, readPath, type PaintEditorController, type StampKind } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { CommitColorInput, ErrorLine, PaintSlider, button, panel, useAttempt } from './shared';

export interface StickerPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * The active layer's stickers: pick one to change its stamp, size, rotation, opacity and colour,
 * bring it to the front or back, or delete it (each change one undo step). Shows nothing for a
 * layer without stickers.
 */
export const StickerPanel: React.FC<StickerPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [picked, setPicked] = useState<string | null>(null);
  const layerId = state.document.activeLayerId;
  const stickers = layerId ? (state.document.stickers?.[layerId] ?? []) : [];
  if (!stickers.length) return null;
  const sel = stickers.find((s) => s.id === picked) ?? null;
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="sticker-panel">
      <span className="font-medium text-slate-300">Stickers ({stickers.length})</span>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Stickers">
        {stickers.map((s) => (
          <button key={s.id} type="button" role="option" aria-selected={s.id === picked} title={`${STAMP_LABELS[s.stamp]} ${s.id}`} className={`h-5 w-5 rounded ring-1 ${s.id === picked ? 'ring-indigo-400' : 'ring-slate-700'}`} style={{ background: s.color }} onClick={() => setPicked(s.id)} />
        ))}
      </div>
      {sel && (
        <div className="flex flex-col gap-1.5" data-testid="sticker-edit">
          <label className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Stamp</span>
            <select aria-label="Sticker stamp" value={sel.stamp} onChange={(e) => attempt(() => controller.updateSticker(layerId!, sel.id, { stamp: e.target.value as StampKind }))} className="rounded bg-slate-800 px-1 py-0.5">
              {STAMP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {STAMP_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {STICKER_SLIDERS.map((c) => (
            <PaintSlider key={c.path} control={c} value={readPath(sel, c.path)} onCommit={(v) => attempt(() => controller.updateSticker(layerId!, sel.id, { [c.path]: v }))} />
          ))}
          <label className="flex items-center justify-between">
            <span className="text-slate-400">Colour</span>
            <CommitColorInput label="Sticker colour" value={sel.color} onCommit={(v) => attempt(() => controller.updateSticker(layerId!, sel.id, { color: v }))} className="h-6 w-10 rounded bg-transparent" />
          </label>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={button} onClick={() => attempt(() => controller.arrangeStickers(layerId!, [sel.id], 'front'))}>
              To front
            </button>
            <button type="button" className={button} onClick={() => attempt(() => controller.arrangeStickers(layerId!, [sel.id], 'back'))}>
              To back
            </button>
            <button type="button" className={button} onClick={() => attempt(() => (controller.removeStickers(layerId!, [sel.id]), setPicked(null)))}>
              Delete
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
