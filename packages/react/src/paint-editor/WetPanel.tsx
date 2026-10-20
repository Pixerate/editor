import React from 'react';
import { WET_FLOW_KINDS, WET_PARAM_SLIDERS, WET_SPEED_SLIDER, WET_TILT_SLIDERS, readPath, type PaintEditorController, type WetFlowKind } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, button, chip, panel, useAttempt } from './shared';

export interface WetPanelProps {
  controller: PaintEditorController;
  className?: string;
}

const FLOW_LABELS: Record<WetFlowKind, string> = { none: 'None', linear: 'One way', swirl: 'Swirl', radial: 'Outwards', turbulent: 'Eddies' };

/**
 * Wet media: whether paint is wet, Dry now, Pause / Resume, the water overlay and speed; Wet paper
 * on the active layer; canvas tilt; the active layer's wet settings (viscosity, evaporation, edge
 * darkening, granulation, blooms, bleed, pigment weight, lifting, staining) and flow map; and the
 * kernel in use, with a note when it runs slower than it could (no cross-origin isolation).
 */
export const WetPanel: React.FC<WetPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const wet = state.wet;
  const layerId = state.document.activeLayerId;
  const info = layerId ? controller.wetLayerInfo(layerId) : null;
  const backend = controller.wetState();
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="wet-panel">
      <div className="flex items-center justify-between">
        <span className={wet.wet ? 'text-sky-300' : 'text-slate-400'} data-testid="wet-status">
          {wet.wet ? (wet.paused ? 'Wet (paused)' : 'Wet') : 'Dry'}
        </span>
        <span className="text-[10px] text-slate-500">step {wet.clock}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={button} disabled={!wet.layerIds.length} onClick={() => attempt(async () => (await controller.wetIdle(), controller.dryPaint()))}>
          Dry now
        </button>
        <button type="button" className={chip(wet.paused)} aria-pressed={wet.paused} onClick={() => controller.setWetPaused(!wet.paused)}>
          {wet.paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className={chip(wet.overlay)} aria-pressed={wet.overlay} onClick={() => controller.setWaterOverlay(!wet.overlay)}>
          Water
        </button>
        <button type="button" className={chip(wet.instantDry)} aria-pressed={wet.instantDry} title="Each wet stroke dries as soon as it ends" onClick={() => controller.setInstantDry(!wet.instantDry)}>
          Instant dry
        </button>
        <button type="button" className={button} disabled={!layerId} onClick={() => attempt(async () => (await controller.wetIdle(), controller.wetPaper({})))}>
          Wet paper
        </button>
      </div>
      <PaintSlider control={WET_SPEED_SLIDER} value={wet.speed} onChange={(v) => controller.setWetSpeed(v)} />
      {WET_TILT_SLIDERS.map((c) => (
        <PaintSlider key={c.path} control={c} value={readPath(wet.tilt, c.path)} onCommit={(v) => attempt(async () => (await controller.wetIdle(), controller.setCanvasTilt({ [c.path]: v })))} />
      ))}
      {info && (
        <div className="flex flex-col gap-1.5" data-testid="wet-layer">
          <span className="font-medium text-slate-300">This layer</span>
          {WET_PARAM_SLIDERS.map((c) => (
            <PaintSlider key={c.path} control={c} value={readPath(info.params, c.path)} onCommit={(v) => attempt(async () => (await controller.wetIdle(), controller.setWetParams(layerId!, { [c.path]: v })))} />
          ))}
          <label className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Flow map</span>
            <select aria-label="Flow map" value={info.flow.kind} onChange={(e) => attempt(async () => (await controller.wetIdle(), controller.setFlowMap(layerId!, { kind: e.target.value as WetFlowKind })))} className="rounded bg-slate-800 px-1 py-0.5">
              {WET_FLOW_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FLOW_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {info.flow.kind !== 'none' && (
            <PaintSlider
              control={{ path: 'strength', label: 'Flow strength', min: 0, max: 1, step: 0.01 }}
              value={info.flow.strength}
              onCommit={(v) => attempt(async () => (await controller.wetIdle(), controller.setFlowMap(layerId!, { strength: v })))}
            />
          )}
        </div>
      )}
      {backend.message && (
        <p className="text-[10px] text-amber-300" data-testid="wet-message">
          {backend.message}
        </p>
      )}
      {backend.backend && (
        <p className="text-[10px] text-slate-500">
          {backend.backend.kind === 'wasm-threads' ? `WebAssembly, ${backend.backend.threads} threads` : backend.backend.kind === 'wasm' ? 'WebAssembly, one thread' : 'JavaScript'}
        </p>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
