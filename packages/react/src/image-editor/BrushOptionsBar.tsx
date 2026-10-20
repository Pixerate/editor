import React, { useEffect, useState } from 'react';
import type { ImageEditorController } from '@pixerate/editor/image-editor';
import {
  BRUSH_OPTION_CONTROLS,
  MIXER_MIXING_OPTIONS,
  MIXER_OPTION_CONTROLS,
  PAINT_TOOLS,
  RETOUCH_CHOICES,
  RETOUCH_OPTION_CONTROLS,
  RETOUCH_TOGGLES,
  cloneSourceLabel,
  isRetouchPaintTool,
  rgbUnitToHex,
  setRetouchChoice,
} from '@pixerate/editor/image-editor';
import { ControlSlider } from './ControlSlider';

export interface BrushOptionsBarProps {
  controller: ImageEditorController;
  className?: string;
}

const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;

/**
 * The paint tools: Move / Brush / Mixer / Eraser, the brush's size, hardness, opacity, flow and
 * smoothing, pressure toggles, the foreground and background colours (D resets, X swaps) and
 * Edit › Fill / Clear on the active layer. With the Mixer Brush: its load (Load brush / Clean
 * brush), Wet / Load / Mix, load and clean each stroke, and the RGB / Pigment mixing toggle.
 * With a retouching tool: the clone source (Alt-click the canvas to set it), Sample, the Spot
 * Healing type, the tone Range, Exposure / Strength and the Aligned / Protect tones / Vibrance
 * toggles that tool uses.
 * Shortcuts are handled by `handlePaintShortcut` in the editor.
 */
export const BrushOptionsBar: React.FC<BrushOptionsBarProps> = ({ controller, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [error, setError] = useState<string | null>(null);
  const state = controller.getState();
  const { brush, foreground, background, mixer, mixerLoad, retouch, cloneSource } = state.paint;
  const tool = state.activeTool as (typeof PAINT_TOOLS)[number]['id'];
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={`flex flex-col gap-2 text-xs text-slate-200 ${className ?? ''}`} data-testid="brush-options">
      <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Paint tools">
        {PAINT_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={state.activeTool === t.id}
            title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
            className={chip(state.activeTool === t.id)}
            onClick={() => controller.setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2" role="group" aria-label="Colours">
        <label className="flex items-center gap-1">
          <input
            type="color"
            aria-label="Foreground colour"
            value={foreground}
            onChange={(e) => controller.setPaintOptions({ foreground: e.target.value })}
            className="h-6 w-8 rounded border border-slate-700 bg-transparent"
          />
          <span className="text-slate-400">FG</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="color"
            aria-label="Background colour"
            value={background}
            onChange={(e) => controller.setPaintOptions({ background: e.target.value })}
            className="h-6 w-8 rounded border border-slate-700 bg-transparent"
          />
          <span className="text-slate-400">BG</span>
        </label>
        <button type="button" title="Swap colours (X)" className={chip(false)} onClick={() => controller.swapPaintColors()}>
          Swap
        </button>
        <button type="button" title="Default colours (D)" className={chip(false)} onClick={() => controller.resetPaintColors()}>
          Default
        </button>
      </div>

      {BRUSH_OPTION_CONTROLS.map((spec) => (
        <ControlSlider
          key={spec.id}
          spec={spec}
          value={brush[spec.id]}
          onChange={(v) => controller.setPaintOptions({ brush: { [spec.id]: v } })}
        />
      ))}

      {state.activeTool === 'mixer' && (
        <div className="flex flex-col gap-2 border-t border-slate-800 pt-2" role="group" aria-label="Mixer Brush" data-testid="mixer-options">
          <div className="flex items-center gap-2">
            <span
              aria-label="Brush load"
              title={mixerLoad.reservoir ? `Loaded ${rgbUnitToHex(mixerLoad.reservoir)}, ${Math.round(mixerLoad.amount * 100)}% left` : 'Unloaded'}
              className="h-6 w-6 rounded border border-slate-700"
              style={{ background: mixerLoad.reservoir ? rgbUnitToHex(mixerLoad.reservoir) : 'transparent' }}
            />
            <button type="button" title="Fill the reservoir with the foreground colour" className={chip(false)} onClick={() => controller.loadMixerBrush()}>
              Load brush
            </button>
            <button type="button" title="Empty the picked-up colour" className={chip(false)} onClick={() => controller.cleanMixerBrush()}>
              Clean brush
            </button>
          </div>
          <div className="flex gap-1" role="group" aria-label="Mixing">
            {MIXER_MIXING_OPTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={mixer.mixing === m.id}
                title={m.title}
                className={chip(mixer.mixing === m.id)}
                onClick={() => controller.setPaintOptions({ mixer: { mixing: m.id } })}
              >
                {m.label}
              </button>
            ))}
          </div>
          {MIXER_OPTION_CONTROLS.map((spec) => (
            <ControlSlider key={spec.id} spec={spec} value={mixer[spec.id]} onChange={(v) => controller.setPaintOptions({ mixer: { [spec.id]: v } })} />
          ))}
          <div className="flex flex-wrap gap-3 text-slate-300">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                aria-label="Load the brush after each stroke"
                checked={mixer.loadEachStroke}
                onChange={(e) => controller.setPaintOptions({ mixer: { loadEachStroke: e.target.checked } })}
                className="accent-indigo-500"
              />
              Load each stroke
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                aria-label="Clean the brush after each stroke"
                checked={mixer.cleanEachStroke}
                onChange={(e) => controller.setPaintOptions({ mixer: { cleanEachStroke: e.target.checked } })}
                className="accent-indigo-500"
              />
              Clean each stroke
            </label>
          </div>
        </div>
      )}

      {isRetouchPaintTool(tool) && (
        <div className="flex flex-col gap-2 border-t border-slate-800 pt-2" role="group" aria-label="Retouch options" data-testid="retouch-options">
          {(tool === 'clone' || tool === 'heal') && (
            <div className="flex items-center gap-2">
              <span className="text-slate-400" data-testid="clone-source">
                {cloneSourceLabel(controller)}
              </span>
              {cloneSource && (
                <button type="button" title="Forget the source point" className={chip(false)} onClick={() => controller.setCloneSource(null)}>
                  Clear source
                </button>
              )}
            </div>
          )}
          {RETOUCH_CHOICES.filter((c) => c.tools.includes(tool)).map((choice) => (
            <div key={choice.id} className="flex flex-wrap items-center gap-1" role="group" aria-label={choice.label}>
              <span className="text-slate-400">{choice.label}</span>
              {choice.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={retouch[choice.id] === o.id}
                  title={o.title}
                  className={chip(retouch[choice.id] === o.id)}
                  onClick={() => setRetouchChoice(controller, choice.id, o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
          {RETOUCH_OPTION_CONTROLS.filter((c) => c.tools.includes(tool)).map((spec) => (
            <ControlSlider key={spec.id} spec={spec} value={retouch[spec.id]} onChange={(v) => controller.setPaintOptions({ retouch: { [spec.id]: v } })} />
          ))}
          <div className="flex flex-wrap gap-3 text-slate-300">
            {RETOUCH_TOGGLES.filter((t) => t.tools.includes(tool)).map((t) => (
              <label key={t.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label={t.label}
                  checked={retouch[t.id]}
                  onChange={(e) => controller.setPaintOptions({ retouch: { [t.id]: e.target.checked } })}
                  className="accent-indigo-500"
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-slate-300" role="group" aria-label="Pressure">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Pressure controls size"
            checked={brush.pressureSize}
            onChange={(e) => controller.setPaintOptions({ brush: { pressureSize: e.target.checked } })}
            className="accent-indigo-500"
          />
          Pressure size
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Pressure controls opacity"
            checked={brush.pressureOpacity}
            onChange={(e) => controller.setPaintOptions({ brush: { pressureOpacity: e.target.checked } })}
            className="accent-indigo-500"
          />
          Pressure opacity
        </label>
      </div>

      <div className="flex gap-1">
        <button type="button" className={chip(false)} onClick={() => attempt(() => controller.fillPixels())}>
          Fill
        </button>
        <button type="button" className={chip(false)} onClick={() => attempt(() => controller.clearPixels())}>
          Clear
        </button>
      </div>
      {error && (
        <p role="alert" className="text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
};
