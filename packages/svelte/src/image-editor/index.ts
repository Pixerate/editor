import type { ComponentProps } from "svelte";
import type ImageEditorComponent from "./ImageEditor.svelte";
import type HistogramComponent from "./Histogram.svelte";
import type AdjustmentLayersPanelComponent from "./AdjustmentLayersPanel.svelte";
import type CurvesEditorComponent from "./CurvesEditor.svelte";
import type ControlSliderComponent from "./ControlSlider.svelte";
import type SelectionOptionsBarComponent from "./SelectionOptionsBar.svelte";
import type RefineEdgePanelComponent from "./RefineEdgePanel.svelte";
import type LayersPanelComponent from "./LayersPanel.svelte";
import type LayerEffectsPanelComponent from "./LayerEffectsPanel.svelte";
import type BrushOptionsBarComponent from "./BrushOptionsBar.svelte";

export { default as ImageEditor } from './ImageEditor.svelte';
export { default as Histogram } from './Histogram.svelte';
export { default as AdjustmentLayersPanel } from './AdjustmentLayersPanel.svelte';
export { default as CurvesEditor } from './CurvesEditor.svelte';
export { default as ControlSlider } from './ControlSlider.svelte';
export { default as SelectionOptionsBar } from './SelectionOptionsBar.svelte';
export { default as RefineEdgePanel } from './RefineEdgePanel.svelte';
export { default as LayersPanel } from './LayersPanel.svelte';
export { default as LayerEffectsPanel } from './LayerEffectsPanel.svelte';
export { default as BrushOptionsBar } from './BrushOptionsBar.svelte';
export * from './imageEditorState.svelte.js';

export type ImageEditorProps = ComponentProps<typeof ImageEditorComponent>;
export type HistogramProps = ComponentProps<typeof HistogramComponent>;
export type AdjustmentLayersPanelProps = ComponentProps<typeof AdjustmentLayersPanelComponent>;
export type CurvesEditorProps = ComponentProps<typeof CurvesEditorComponent>;
export type ControlSliderProps = ComponentProps<typeof ControlSliderComponent>;
export type SelectionOptionsBarProps = ComponentProps<typeof SelectionOptionsBarComponent>;
export type RefineEdgePanelProps = ComponentProps<typeof RefineEdgePanelComponent>;
export type LayersPanelProps = ComponentProps<typeof LayersPanelComponent>;
export type LayerEffectsPanelProps = ComponentProps<typeof LayerEffectsPanelComponent>;
export type BrushOptionsBarProps = ComponentProps<typeof BrushOptionsBarComponent>;

export {
	applyRegionMosaic,
	applyRegionBlur,
	resolveMosaicRegionBounds,
	type MosaicRegion,
	type MosaicImageDataLike
} from '@pixerate/editor/image-editor';
