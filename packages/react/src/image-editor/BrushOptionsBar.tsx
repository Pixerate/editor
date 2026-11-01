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
  CLONE_TRANSFORM_CONTROLS,
  cloneSourceLabel,
  cloneTransformView,
  setCloneTransformValue,
  isRetouchPaintTool,
  rgbUnitToHex,
  setRetouchChoice,
} from '@pixerate/editor/image-editor';
import { DEFAULT_PAINT_GRADIENT, userErrorMessage } from '@pixerate/editor/image-editor';
import { PaintGradientEditor } from './PaintGradientEditor';
import { ControlSlider } from './ControlSlider';
import { imageChipClass } from './styles';
import { ImageCheckbox, ImageColor, ImageRange, ImageSelect } from './controls/controls.js';

export interface BrushOptionsBarProps {
  controller: ImageEditorController;
  /** The row of paint tool buttons (default true); hide it when the host has its own toolbar. */
  showTools?: boolean;
  className?: string;
}



/**
 * The paint tools: Move / Brush / Mixer / Eraser, the brush's size, hardness, opacity, flow and
 * smoothing, pressure toggles, the foreground and background colours (D resets, X swaps) and
 * Edit › Fill / Clear on the active layer, and gradient paint for the brush (the colour changes as
 * the stroke goes; `PaintGradientEditor`). With the Mixer Brush: its load (Load brush / Clean
 * brush), Wet / Load / Mix, load and clean each stroke, and the RGB / Pigment mixing toggle.
 * With a retouching tool: the clone source (Alt-click the canvas to set it), Sample, the Spot
 * Healing type, the tone Range, Exposure / Strength and the Aligned / Protect tones / Vibrance
 * toggles that tool uses.
 * Shortcuts are handled by `handlePaintShortcut` in the editor.
 */
export const BrushOptionsBar: React.FC<BrushOptionsBarProps> = ({ controller, showTools = true, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [error, setError] = useState<string | null>(null);
  const state = controller.getState();
  const { brush, foreground, background, mixer, mixerLoad, retouch, cloneSource, paint } = state.paint;
  const tool = state.activeTool as (typeof PAINT_TOOLS)[number]['id'];
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      fn();
    } catch (err) {
      setError(userErrorMessage(err));
    }
  };

  return (
    <div className={`flex flex-col gap-2 text-xs text-foreground ${className ?? ''}`} data-testid="brush-options">
      {showTools && (
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Paint tools">
          {PAINT_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={state.activeTool === t.id}
              title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
              className={imageChipClass(state.activeTool === t.id)}
              onClick={() => controller.setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2" role="group" aria-label="Colours">
        <label className="flex items-center gap-1">
          <ImageColor label="Foreground colour" value={foreground} onChange={(fg) => controller.setPaintOptions({ foreground: fg })} />
          <span className="text-muted-foreground">FG</span>
        </label>
        <label className="flex items-center gap-1">
          <ImageColor label="Background colour" value={background} onChange={(bg) => controller.setPaintOptions({ background: bg })} />
          <span className="text-muted-foreground">BG</span>
        </label>
        <button type="button" title="Swap colours (X)" className={imageChipClass(false)} onClick={() => controller.swapPaintColors()}>
          Swap
        </button>
        <button type="button" title="Default colours (D)" className={imageChipClass(false)} onClick={() => controller.resetPaintColors()}>
          Default
        </button>
        {state.activeTool === 'brush' && (
          <button
            type="button"
            aria-pressed={paint.type === 'gradient'}
            title="Gradient paint: the brush changes colour as the stroke goes"
            className={imageChipClass(paint.type === 'gradient')}
            onClick={() => attempt(() => controller.setPaintOptions(paint.type === 'gradient' ? { foreground } : { paint: DEFAULT_PAINT_GRADIENT }))}
          >
            Gradient
          </button>
        )}
      </div>
      {state.activeTool === 'brush' && paint.type === 'gradient' && (
        <PaintGradientEditor value={paint} colors={{ paint: foreground, secondary: background }} onChange={(g) => attempt(() => controller.setPaintOptions({ paint: g }))} />
      )}

      {BRUSH_OPTION_CONTROLS.map((spec) => (
        <ControlSlider
          key={spec.id}
          spec={spec}
          value={brush[spec.id]}
          onChange={(v) => controller.setPaintOptions({ brush: { [spec.id]: v } })}
        />
      ))}

      {state.activeTool === 'mixer' && (
        <div className="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label="Mixer Brush" data-testid="mixer-options">
          <div className="flex items-center gap-2">
            <span
              aria-label="Brush load"
              title={mixerLoad.reservoir ? `Loaded ${rgbUnitToHex(mixerLoad.reservoir)}, ${Math.round(mixerLoad.amount * 100)}% left` : 'Unloaded'}
              className="h-6 w-6 rounded border border-border"
              style={{ background: mixerLoad.reservoir ? rgbUnitToHex(mixerLoad.reservoir) : 'transparent' }}
            />
            <button type="button" title="Fill the reservoir with the foreground colour" className={imageChipClass(false)} onClick={() => controller.loadMixerBrush()}>
              Load brush
            </button>
            <button type="button" title="Empty the picked-up colour" className={imageChipClass(false)} onClick={() => controller.cleanMixerBrush()}>
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
                className={imageChipClass(mixer.mixing === m.id)}
                onClick={() => controller.setPaintOptions({ mixer: { mixing: m.id } })}
              >
                {m.label}
              </button>
            ))}
          </div>
          {MIXER_OPTION_CONTROLS.map((spec) => (
            <ControlSlider key={spec.id} spec={spec} value={mixer[spec.id]} onChange={(v) => controller.setPaintOptions({ mixer: { [spec.id]: v } })} />
          ))}
          <div className="flex flex-wrap gap-3 text-foreground">
            <label className="flex items-center gap-1.5">
              <ImageCheckbox label="Load the brush after each stroke" checked={mixer.loadEachStroke} onChange={(on) => controller.setPaintOptions({ mixer: { loadEachStroke: on } })} />
              Load each stroke
            </label>
            <label className="flex items-center gap-1.5">
              <ImageCheckbox label="Clean the brush after each stroke" checked={mixer.cleanEachStroke} onChange={(on) => controller.setPaintOptions({ mixer: { cleanEachStroke: on } })} />
              Clean each stroke
            </label>
          </div>
        </div>
      )}

      {isRetouchPaintTool(tool) && (
        <div className="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label="Retouch options" data-testid="retouch-options">
          {(tool === 'clone' || tool === 'heal') && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground" data-testid="clone-source">
                {cloneSourceLabel(controller)}
              </span>
              {cloneSource && (
                <button type="button" title="Forget the source point" className={imageChipClass(false)} onClick={() => controller.setCloneSource(null)}>
                  Clear source
                </button>
              )}
            </div>
          )}
          {(tool === 'clone' || tool === 'heal') && (
            <div className="flex flex-col gap-1" role="group" aria-label="Clone source transform" data-testid="clone-transform">
              {CLONE_TRANSFORM_CONTROLS.map((spec) => (
                <ControlSlider key={spec.id} spec={spec} value={cloneTransformView(controller)[spec.id]} onChange={(v) => setCloneTransformValue(controller, spec.id, v)} />
              ))}
              <div className="flex items-center gap-1">
                <button type="button" aria-pressed={cloneTransformView(controller).flipH} title="Mirror the source left to right" className={imageChipClass(cloneTransformView(controller).flipH)} onClick={() => setCloneTransformValue(controller, 'flipH')}>
                  Flip H
                </button>
                <button type="button" aria-pressed={cloneTransformView(controller).flipV} title="Mirror the source top to bottom" className={imageChipClass(cloneTransformView(controller).flipV)} onClick={() => setCloneTransformValue(controller, 'flipV')}>
                  Flip V
                </button>
                {!cloneTransformView(controller).identity && (
                  <button type="button" title="Back to 100 %, no flip, 0°" className={imageChipClass(false)} onClick={() => controller.setCloneTransform(null)}>
                    Reset transform
                  </button>
                )}
              </div>
            </div>
          )}
          {RETOUCH_CHOICES.filter((c) => c.tools.includes(tool)).map((choice) => (
            <div key={choice.id} className="flex flex-wrap items-center gap-1" role="group" aria-label={choice.label}>
              <span className="text-muted-foreground">{choice.label}</span>
              {choice.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={retouch[choice.id] === o.id}
                  title={o.title}
                  className={imageChipClass(retouch[choice.id] === o.id)}
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
          <div className="flex flex-wrap gap-3 text-foreground">
            {RETOUCH_TOGGLES.filter((t) => t.tools.includes(tool)).map((t) => (
              <label key={t.id} className="flex items-center gap-1.5">
                <ImageCheckbox label={t.label} checked={retouch[t.id]} onChange={(on) => controller.setPaintOptions({ retouch: { [t.id]: on } })} />
                {t.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-foreground" role="group" aria-label="Pressure">
        <label className="flex items-center gap-1.5">
          <ImageCheckbox label="Pressure controls size" checked={brush.pressureSize} onChange={(on) => controller.setPaintOptions({ brush: { pressureSize: on } })} />
          Pressure size
        </label>
        <label className="flex items-center gap-1.5">
          <ImageCheckbox label="Pressure controls opacity" checked={brush.pressureOpacity} onChange={(on) => controller.setPaintOptions({ brush: { pressureOpacity: on } })} />
          Pressure opacity
        </label>
      </div>

      <div className="flex gap-1">
        <button type="button" className={imageChipClass(false)} onClick={() => attempt(() => controller.fillPixels())}>
          Fill
        </button>
        <button type="button" className={imageChipClass(false)} onClick={() => attempt(() => controller.clearPixels())}>
          Clear
        </button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
