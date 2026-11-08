import React from 'react';
import { CULTURE_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, button, chip, panel, useAttempt } from './shared';

export interface CulturePanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * Biopaint (`culture`) panel: inspect living mycelial colonies across layers, step growth (`growCultures`),
 * pause or resume live growth, kill living tips on the active layer (`removeCultures`), toggle
 * `growWhileClosed`, and tune the active brush's `culture` facet (`reach`, `branching`, `wander`,
 * `appetite`, `digest`, `fuse`, `thickness`, `glow`).
 */
export const CulturePanel: React.FC<CulturePanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const { cultures, brush } = state;
  const activeId = state.document.activeLayerId;
  const activeColony = cultures.layers.find((l) => l.layerId === activeId) ?? cultures.layers[0] ?? null;
  const totalTips = cultures.layers.reduce((acc, l) => acc + l.tips, 0);
  const totalSegments = cultures.layers.reduce((acc, l) => acc + l.segments, 0);
  const canCarryCulture = ['dab', 'mixer', 'impasto', 'particle', 'bristle'].includes(brush.engine);

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="culture-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-300">Biopaint (mycelial ink)</span>
        <div className="flex gap-1">
          <button type="button" className={button} onClick={() => attempt(() => controller.growCultures({ steps: 40 }))}>
            Grow
          </button>
          <button
            type="button"
            aria-pressed={cultures.paused}
            className={chip(cultures.paused)}
            onClick={() => controller.setCulturePaused(!cultures.paused)}
          >
            {cultures.paused ? 'Paused' : 'Pause'}
          </button>
          <button
            type="button"
            className={button}
            disabled={!activeColony || activeColony.tips === 0}
            onClick={() => attempt(() => controller.removeCultures(activeColony?.layerId))}
          >
            Kill colony
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {activeColony
            ? `${totalTips} living tips · ${totalSegments} segments (${activeColony.status})`
            : 'No mycelial colony on canvas'}
        </span>
      </div>
      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={cultures.growWhileClosed}
          onChange={(e) => attempt(() => controller.setCultureOptions({ growWhileClosed: e.target.checked }))}
        />
        Grow while closed
      </label>
      {canCarryCulture && (
        <div className="flex flex-col gap-1 border-t border-slate-800 pt-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Brush spores</span>
            <button
              type="button"
              aria-pressed={Boolean(brush.culture)}
              className={chip(Boolean(brush.culture))}
              onClick={() => attempt(() => controller.setBrush({ culture: brush.culture ? null : {} }))}
            >
              {brush.culture ? 'On' : 'Off'}
            </button>
          </div>
          {brush.culture &&
            CULTURE_SLIDERS.map((c) => {
              const key = c.path.replace(/^culture\./, '');
              return (
                <PaintSlider
                  key={c.path}
                  control={c}
                  value={readPath(brush.culture, key)}
                  onCommit={(v) => attempt(() => controller.setBrush({ culture: { [key]: v } }))}
                />
              );
            })}
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
