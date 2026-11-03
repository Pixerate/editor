import React from 'react';
import { STICKER_SLIDERS, readPath, stickerRefLabel, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { StickerPicker } from './StickerPicker';
import { usePaintEditorState } from './usePaintEditor';
import { CommitColorInput, ErrorLine, PaintSlider, button, panel, useAttempt } from './shared';

export interface StickerPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * The active layer's stickers: pick one (here, or with the Stickers tool on the canvas) to change
 * its sticker (from the sticker library), place, size, rotation, opacity and colour, bring it to the front or back, or delete it
 * (each change one undo step). Shows nothing for a layer without stickers.
 */
export const StickerPanel: React.FC<StickerPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const picked = state.selectedSticker;
  const setPicked = (id: string | null) => controller.selectSticker(id);
  const layerId = state.document.activeLayerId;
  const stickers = layerId ? (state.document.stickers?.[layerId] ?? []) : [];
  if (!stickers.length) return null;
  const sel = stickers.find((s) => s.id === picked) ?? null;
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="sticker-panel">
      <span className="font-medium text-slate-300">Stickers ({stickers.length})</span>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Stickers">
        {stickers.map((s) => (
          <button key={s.id} type="button" role="option" aria-selected={s.id === picked} title={`${stickerRefLabel(s.ref)} ${s.id}`} className={`h-5 w-5 rounded ring-1 ${s.id === picked ? 'ring-indigo-400' : 'ring-slate-700'}`} style={{ background: s.color }} onClick={() => setPicked(s.id)} />
        ))}
      </div>
      {sel && (
        <div className="flex flex-col gap-1.5" data-testid="sticker-edit">
          <span className="text-slate-400">Sticker</span>
          <StickerPicker
            controller={controller}
            label="Sticker art"
            selected={[sel.ref]}
            onPick={(ref) =>
              // The layer is redrawn, so the new sticker's art (and every other's) loads first.
              void controller
                .prepareStickers([ref, ...stickers.map((x) => x.ref)])
                .then(() => attempt(() => controller.updateSticker(layerId!, sel.id, { ref })))
                .catch((e: unknown) => attempt(() => { throw e; }))
            }
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Position</span>
            <span className="flex gap-1">
              {(['x', 'y'] as const).map((k) => (
                <input
                  key={`${sel.id}-${k}-${sel[k]}`}
                  type="number"
                  aria-label={`Sticker ${k}`}
                  defaultValue={sel[k]}
                  step={1}
                  onBlur={(e) => Number(e.target.value) !== sel[k] && attempt(() => controller.updateSticker(layerId!, sel.id, { [k]: Number(e.target.value) }))}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  className="w-16 rounded bg-slate-800 px-1 py-0.5"
                />
              ))}
            </span>
          </div>
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
