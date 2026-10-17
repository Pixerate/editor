import type { ComponentProps } from "svelte";
import type ImageEditorComponent from "./ImageEditor.svelte";
import type HistogramComponent from "./Histogram.svelte";
import type AdjustmentLayersPanelComponent from "./AdjustmentLayersPanel.svelte";
import type CurvesEditorComponent from "./CurvesEditor.svelte";
import type ControlSliderComponent from "./ControlSlider.svelte";
import type SelectionOptionsBarComponent from "./SelectionOptionsBar.svelte";
import type RefineEdgePanelComponent from "./RefineEdgePanel.svelte";

export { default as ImageEditor } from './ImageEditor.svelte';
export { default as Histogram } from './Histogram.svelte';
export { default as AdjustmentLayersPanel } from './AdjustmentLayersPanel.svelte';
export { default as CurvesEditor } from './CurvesEditor.svelte';
export { default as ControlSlider } from './ControlSlider.svelte';
export { default as SelectionOptionsBar } from './SelectionOptionsBar.svelte';
export { default as RefineEdgePanel } from './RefineEdgePanel.svelte';
export * from './imageEditorState.svelte.js';

export type ImageEditorProps = ComponentProps<typeof ImageEditorComponent>;
export type HistogramProps = ComponentProps<typeof HistogramComponent>;
export type AdjustmentLayersPanelProps = ComponentProps<typeof AdjustmentLayersPanelComponent>;
export type CurvesEditorProps = ComponentProps<typeof CurvesEditorComponent>;
export type ControlSliderProps = ComponentProps<typeof ControlSliderComponent>;
export type SelectionOptionsBarProps = ComponentProps<typeof SelectionOptionsBarComponent>;
export type RefineEdgePanelProps = ComponentProps<typeof RefineEdgePanelComponent>;

export {
	applyRegionMosaic,
	applyRegionBlur,
	resolveMosaicRegionBounds,
	type MosaicRegion,
	type MosaicImageDataLike
} from '@pixerate/editor/image-editor';
