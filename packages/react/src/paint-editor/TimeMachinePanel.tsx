import React from 'react';
import { AGE_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, button, chip, panel, useAttempt } from './shared';

export interface TimeMachinePanelProps {
  controller: PaintEditorController;
  className?: string;
}

/**
 * Painting time machine panel: non-destructive museum ageing preview (`years`, `varnish`,
 * `cracks`, `fading`, `dust`, `seed`), `bakeAge` to commit the aged look into a new layer,
 * viewport X-ray toggle (`setXrayView`) to reveal buried pentimenti, and quick selection of the
 * `paint-scraper` excavation brush.
 */
export const TimeMachinePanel: React.FC<TimeMachinePanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const age = state.age;

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="time-machine-panel">
      <div className="flex items-center justify-between gap-1">
        <span className="font-medium text-slate-300">Time machine (ageing &amp; X-ray)</span>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={chip(age.years === 300)}
            onClick={() => attempt(() => controller.setAge({ years: 300 }))}
          >
            Age 300 yr
          </button>
          {age.years > 0 && (
            <button type="button" className={button} onClick={() => attempt(() => controller.setAge({ years: 0 }))}>
              Fresh
            </button>
          )}
        </div>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.xrayView}
          onChange={(e) => attempt(() => controller.setXrayView(e.target.checked))}
        />{' '}
        X-ray view (pentimento)
      </label>
      {AGE_SLIDERS.map((c) => (
        <PaintSlider
          key={c.path}
          control={c}
          value={readPath(age, c.path)}
          onChange={(v) => attempt(() => controller.setAge({ [c.path]: v }))}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={button}
          disabled={age.years <= 0}
          onClick={() => attempt(() => controller.bakeAge())}
        >
          Bake age
        </button>
        <button type="button" className={button} onClick={() => attempt(() => controller.setAge({ seed: age.seed + 1 }))}>
          New crack seed
        </button>
        <button
          type="button"
          className={chip(state.brush.id === 'paint-scraper')}
          onClick={() => attempt(() => controller.setBrush({ id: 'paint-scraper' }))}
        >
          Scraper brush
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
};
