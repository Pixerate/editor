import React, { useMemo } from 'react';
import { MAGNET_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, button, panel, useAttempt } from './shared';

export interface FerroPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * Ferrofluid & magnets panel: add, adjust (`strength`, `radius`) and remove magnets on the canvas,
 * inspect liquid ferrofluid spike relief on the active layer, and cure liquid spikes into permanent
 * impasto height (`cureFerrofluid`).
 */
export const FerroPanel: React.FC<FerroPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const magnets = state.document.magnets ?? [];
  const activeId = state.document.activeLayerId;
  const info = useMemo(() => {
    try {
      return activeId ? controller.getFerrofluid(activeId) : null;
    } catch {
      return null;
    }
  }, [controller, state.document, activeId]);

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="ferro-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-300">Ferrofluid & magnets</span>
        <div className="flex gap-1">
          <button
            type="button"
            className={button}
            onClick={() => attempt(() => controller.addMagnet({ x: Math.round(state.document.canvas.width / 2), y: Math.round(state.document.canvas.height / 2) }))}
          >
            Add magnet
          </button>
          {magnets.length > 0 && (
            <button type="button" className={button} onClick={() => attempt(() => controller.removeMagnets())}>
              Clear magnets
            </button>
          )}
        </div>
      </div>
      {magnets.map((m) => (
        <div key={m.id} className="flex flex-col gap-1 rounded border border-slate-800 p-1.5" data-magnet={m.id}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-mono text-slate-300">
              {m.id} ({Math.round(m.x)}, {Math.round(m.y)})
            </span>
            <button type="button" aria-label={`Remove magnet ${m.id}`} className="px-1 text-slate-400 hover:text-white" onClick={() => attempt(() => controller.removeMagnets([m.id]))}>
              ×
            </button>
          </div>
          {MAGNET_SLIDERS.map((c) => (
            <PaintSlider
              key={c.path}
              control={{ ...c, label: `${c.label} (${m.id})` }}
              value={readPath(m, c.path)}
              onCommit={(v) => attempt(() => controller.updateMagnet(m.id, { [c.path]: v }))}
            />
          ))}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">
          {info?.ferro ? `${info.activeSpikeArea} spike px · max ${Math.round(info.maxSpikeHeight * 100)}%` : 'No liquid ferrofluid on layer'}
        </span>
        <button type="button" className={button} disabled={!info?.ferro} onClick={() => attempt(() => controller.cureFerrofluid())}>
          Cure ferrofluid
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
};
