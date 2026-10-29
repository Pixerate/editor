import { matchParameterOptionValue } from '@pixerate/editor/parameters';
import type { ParameterColorProps, ParameterComponents, ParameterSelectProps, ParameterSliderProps } from '../../parameters/controls.js';
import { ImageColor, ImageRange, ImageSelect, type ImageEditorControls } from './controls.js';

/** A parameter slider drawn with the host's image-editor `Range`. */
function ImageParameterSlider({ value, min, max, step, label, disabled, className, onChange, onGestureStart, onGestureEnd }: ParameterSliderProps) {
  return (
    <ImageRange
      value={value}
      min={min}
      max={max}
      step={step}
      label={label}
      disabled={disabled}
      className={className}
      onChange={onChange}
      onStart={onGestureStart}
      onEnd={onGestureEnd}
    />
  );
}

/** A parameter select drawn with the host's image-editor `Select` (string values mapped back to the options' own). */
function ImageParameterSelect({ value, options, label, disabled, className, onChange }: ParameterSelectProps) {
  return (
    <ImageSelect
      value={String(value)}
      options={options.map((o) => ({ value: String(o.value), label: o.label }))}
      label={label}
      disabled={disabled}
      className={className}
      onChange={(v) => onChange(matchParameterOptionValue(options, v))}
    />
  );
}

/** A parameter colour drawn with the host's image-editor `Color`. */
function ImageParameterColor({ value, alpha, label, disabled, className, onChange, onGestureStart, onGestureEnd }: ParameterColorProps) {
  return (
    <ImageColor
      value={value}
      alpha={alpha}
      label={label}
      disabled={disabled}
      className={className}
      onChange={onChange}
      onStart={onGestureStart}
      onEnd={onGestureEnd}
    />
  );
}

/** The host's image-editor `Range`, `Select` and `Color` as parameter controls (only the ones it set). */
export function imageEditorParameterComponents(controls: ImageEditorControls): ParameterComponents {
  return {
    slider: controls.Range ? ImageParameterSlider : undefined,
    select: controls.Select ? ImageParameterSelect : undefined,
    color: controls.Color ? ImageParameterColor : undefined,
  };
}
