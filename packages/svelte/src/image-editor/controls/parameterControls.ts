import type { ParameterComponents } from '../../parameters/controls.js';
import type { ImageEditorControls } from './controls.js';
import ImageParameterSelect from './ImageParameterSelect.svelte';
import ImageParameterSlider from './ImageParameterSlider.svelte';

/** The host's image-editor `Range` and `Select` as parameter controls (only the ones it set). */
export function imageEditorParameterComponents(controls: ImageEditorControls): ParameterComponents {
  return {
    slider: controls.Range ? ImageParameterSlider : undefined,
    select: controls.Select ? ImageParameterSelect : undefined,
  };
}
