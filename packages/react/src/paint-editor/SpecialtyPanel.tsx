import React, { useEffect, useState } from 'react';
import { UV_LIGHT_SLIDERS, VIEW_TILT_SLIDERS, brushSpecialtyGuides, readPath, requestDeviceTiltPermission, runBrushSpecialtyAction, startDeviceTilt, warmCanvasHeat, type BrushSpecialtyGuide, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { FerroPanel } from './FerroPanel';
import { ErrorLine, PaintSlider, button, chip, panel, useAttempt } from './shared';

export interface SpecialtyGuideCardProps {
  controller: PaintEditorController;
  /** With it, an "Open Specialty panel" button (the paint editor switches to its Specialty tab). */
  onOpenSpecialtyPanel?: () => void;
  className?: string;
}

/**
 * How to use the active brush's specialty paint (`brushSpecialtyGuides`): one card per specialty
 * with its how-to, the canvas's live status and one-click setup actions (UV blacklight, heat,
 * magnets, view tilt, seeding). Renders nothing for a standard brush.
 */
export const SpecialtyGuideCard: React.FC<SpecialtyGuideCardProps> = ({ controller, onOpenSpecialtyPanel, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const guides = brushSpecialtyGuides(state);
  if (!guides.length) return null;
  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-indigo-500/40 bg-indigo-950/30 p-2 ${className ?? ''}`} data-testid="brush-specialty-guide">
      {guides.map((g) => (
        <GuideItem key={g.kind} guide={g} onAction={(a) => attempt(() => runBrushSpecialtyAction(controller, a))} />
      ))}
      {onOpenSpecialtyPanel && (
        <button type="button" className={`${button} self-start`} onClick={onOpenSpecialtyPanel}>
          Open Specialty panel
        </button>
      )}
      <ErrorLine error={error} />
    </div>
  );
};

const GuideItem: React.FC<{ guide: BrushSpecialtyGuide; onAction: (a: BrushSpecialtyGuide['actions'][number]) => void }> = ({ guide: g, onAction }) => (
  <div className="flex flex-col gap-1" data-specialty={g.kind}>
    <div className="flex items-center gap-1.5">
      <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">Specialty</span>
      <span className="font-medium text-slate-200">{g.title}</span>
    </div>
    <p className="text-[11px] leading-snug text-slate-400">{g.howToUse}</p>
    <p role="status" data-ready={g.ready} className={`text-[11px] ${g.ready ? 'text-emerald-400' : 'text-amber-400'}`}>
      {g.ready ? '● ' : '○ '}
      {g.status}
    </p>
    {g.actions.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {g.actions.map((a) => (
          <button key={a.id} type="button" className={button} data-action={a.id} title={`${a.tool}`} onClick={() => onAction(a)}>
            {a.label}
          </button>
        ))}
      </div>
    )}
  </div>
);

export interface SpecialtyPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/** Specialty presets offered as a quick pick while a standard brush is active. */
const PICKS = ['ferrofluid', 'uv-marker', 'thermo-ink', 'soap-film', 'ghost-wash', 'mutation-wash', 'turing-wash'];

/**
 * The canvas environment for specialty paint: the active brush's guide (or a quick pick of
 * specialty brushes while a standard one is active), the UV blacklight and heat for UV-fluorescent
 * and thermochromic ink, magnets for ferrofluid, and the view tilt for thin-film iridescence.
 */
export const SpecialtyPanel: React.FC<SpecialtyPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [tiltFollow, setTiltFollow] = useState(false);
  useEffect(() => (tiltFollow ? startDeviceTilt(controller) : undefined), [controller, tiltFollow]);
  const guides = brushSpecialtyGuides(state);
  const picks = PICKS.filter((id) => state.brushes.some((b) => b.id === id));
  const heat = state.heat;
  const tilted = state.viewTilt.x !== 0 || state.viewTilt.y !== 0;
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="specialty-panel">
      {guides.length ? (
        <SpecialtyGuideCard controller={controller} />
      ) : (
        <div className="flex flex-col gap-1" data-testid="specialty-picks">
          <span className="text-slate-400">The active brush is a standard one. Pick a specialty brush:</span>
          <div className="flex flex-wrap gap-1">
            {picks.map((id) => (
              <button key={id} type="button" className={button} onClick={() => attempt(() => controller.setBrush({ id }))}>
                {state.brushes.find((b) => b.id === id)!.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5" data-testid="uv-heat-panel">
        <span className="font-medium text-slate-300">UV blacklight &amp; heat</span>
        <p className="text-[11px] leading-snug text-slate-500">UV-fluorescent ink (UV marker) glows in its own colour under the blacklight; invisible UV ink shows only under it. Thermochromic ink (Thermochromic ink preset) shifts toward its hot colour where the canvas is warm.</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={state.uvLight.on} onChange={(e) => attempt(() => controller.setUvLight({ on: e.target.checked }))} /> UV blacklight
        </label>
        {UV_LIGHT_SLIDERS.map((c) => (
          <PaintSlider key={c.path} control={c} value={readPath(state.uvLight, c.path)} onChange={(v) => attempt(() => controller.setUvLight({ [c.path]: v }))} />
        ))}
        <span className="text-[11px] text-slate-400" role="status">
          {heat.hotCells > 0 ? `Canvas heat: ${Math.round(heat.max * 100)}% at its warmest` : 'Canvas is cool'}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={button} onClick={() => attempt(() => controller.paintHeat(warmCanvasHeat(state.document.canvas)))}>
            Warm canvas
          </button>
          <button type="button" className={button} disabled={heat.hotCells === 0} onClick={() => attempt(() => controller.advanceHeat(10))}>
            Step heat
          </button>
          <button type="button" className={button} disabled={heat.hotCells === 0} onClick={() => attempt(() => controller.clearHeat())}>
            Cool canvas
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] leading-snug text-slate-500">Ferrofluid and Ferro ink pool into liquid magnetic paint that magnets pull into 3D Rosensweig spikes.</p>
        <FerroPanel controller={controller} />
      </div>
      <div className="flex flex-col gap-1.5" data-testid="view-tilt-panel">
        <span className="font-medium text-slate-300">Thin-film iridescence &amp; view tilt</span>
        <p className="text-[11px] leading-snug text-slate-500">Scarab lacquer, Soap film and Pearl glaze shift colour with the viewing angle.</p>
        {VIEW_TILT_SLIDERS.map((c) => (
          <PaintSlider key={c.path} control={c} value={readPath(state.viewTilt, c.path)} onChange={(v) => attempt(() => controller.setViewTilt({ [c.path]: v }))} />
        ))}
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={button} disabled={!tilted} onClick={() => attempt(() => controller.setViewTilt({ x: 0, y: 0 }))}>
            Reset tilt
          </button>
          <button
            type="button"
            aria-pressed={tiltFollow}
            className={chip(tiltFollow)}
            onClick={() =>
              attempt(async () => {
                if (!tiltFollow && !(await requestDeviceTiltPermission())) return;
                setTiltFollow((v) => !v);
              })
            }
          >
            Device tilt
          </button>
        </div>
      </div>
      <ErrorLine error={error} />
    </div>
  );
};

