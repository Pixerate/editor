import type { ComponentProps } from "svelte";
import type ImageEditorComponent from "./ImageEditor.svelte";
import type ImageEditorCanvasComponent from "./ImageEditorCanvas.svelte";
import type ImageEffectControlsComponent from "./ImageEffectControls.svelte";
import type HistogramComponent from "./Histogram.svelte";
import type AdjustmentLayersPanelComponent from "./AdjustmentLayersPanel.svelte";
import type CurvesEditorComponent from "./CurvesEditor.svelte";
import type ControlSliderComponent from "./ControlSlider.svelte";
import type SelectionOptionsBarComponent from "./SelectionOptionsBar.svelte";
import type RefineEdgePanelComponent from "./RefineEdgePanel.svelte";
import type MaskEdgeCheckComponent from "./MaskEdgeCheck.svelte";
import type PathsPanelComponent from "./PathsPanel.svelte";
import type SelectAndMaskWorkspaceComponent from "./SelectAndMaskWorkspace.svelte";
import type ContentAwareFillWorkspaceComponent from "./ContentAwareFillWorkspace.svelte";
import type ChannelsPanelComponent from "./ChannelsPanel.svelte";
import type LayersPanelComponent from "./LayersPanel.svelte";
import type ColorProfilePanelComponent from "./ColorProfilePanel.svelte";
import type LayerEffectsPanelComponent from "./LayerEffectsPanel.svelte";
import type BrushOptionsBarComponent from "./BrushOptionsBar.svelte";
import type FreeTransformOptionsBarComponent from "./FreeTransformOptionsBar.svelte";
import type ShapeOptionsBarComponent from "./ShapeOptionsBar.svelte";
import type TypeOptionsBarComponent from "./TypeOptionsBar.svelte";
import type ImageProviderEffectsPanelComponent from "./ImageProviderEffectsPanel.svelte";

import type CanvasSizePanelComponent from "./CanvasSizePanel.svelte";
import type LayerPanelComponent from "./LayerPanel.svelte";

export { default as ImageEditor } from './ImageEditor.svelte';
export { default as ImageEditorCanvas } from './ImageEditorCanvas.svelte';
export { default as CanvasSizePanel } from './CanvasSizePanel.svelte';
export { default as LayerPanel } from './LayerPanel.svelte';
export { default as ImageEffectControls } from './ImageEffectControls.svelte';
export type { ImageEditorCanvasMode, ImageEditorCanvasErrorSource } from './canvasTypes.js';
export { default as PaintGradientEditor } from './PaintGradientEditor.svelte';
export { default as Histogram } from './Histogram.svelte';
export { default as AdjustmentLayersPanel } from './AdjustmentLayersPanel.svelte';
export { default as CurvesEditor } from './CurvesEditor.svelte';
export { default as ControlSlider } from './ControlSlider.svelte';
export { default as SelectionOptionsBar } from './SelectionOptionsBar.svelte';
export { default as RefineEdgePanel } from './RefineEdgePanel.svelte';
export { default as MaskEdgeCheck } from './MaskEdgeCheck.svelte';
export { default as PathsPanel } from './PathsPanel.svelte';
export { default as SelectAndMaskWorkspace } from './SelectAndMaskWorkspace.svelte';
export { default as ContentAwareFillWorkspace } from './ContentAwareFillWorkspace.svelte';
export { default as ChannelsPanel } from './ChannelsPanel.svelte';
export { default as LayersPanel } from './LayersPanel.svelte';
export { default as ColorProfilePanel } from './ColorProfilePanel.svelte';
export { default as LayerEffectsPanel } from './LayerEffectsPanel.svelte';
export { default as BrushOptionsBar } from './BrushOptionsBar.svelte';
export { default as FreeTransformOptionsBar } from './FreeTransformOptionsBar.svelte';
export { default as ShapeOptionsBar } from './ShapeOptionsBar.svelte';
export { default as TypeOptionsBar } from './TypeOptionsBar.svelte';
export { default as ImageProviderEffectsPanel } from './ImageProviderEffectsPanel.svelte';
export * from './imageEditorState.svelte.js';
export { default as ImageCheckbox } from './controls/ImageCheckbox.svelte';
export { default as ImageRange } from './controls/ImageRange.svelte';
export { default as ImageSelect } from './controls/ImageSelect.svelte';
export { default as ImageColor } from './controls/ImageColor.svelte';
export {
  setImageEditorControls,
  getImageEditorControls,
  type ImageEditorControls,
  type ImageCheckboxProps,
  type ImageRangeProps,
  type ImageSelectProps,
  type ImageSelectOption,
  type ImageColorProps,
} from './controls/controls.js';

export type ImageEditorProps = ComponentProps<typeof ImageEditorComponent>;
export type ImageEditorCanvasProps = ComponentProps<typeof ImageEditorCanvasComponent>;
export type CanvasSizePanelProps = ComponentProps<typeof CanvasSizePanelComponent>;
export type LayerPanelPropsComponent = ComponentProps<typeof LayerPanelComponent>;
export type ImageEffectControlsProps = ComponentProps<typeof ImageEffectControlsComponent>;
export type HistogramProps = ComponentProps<typeof HistogramComponent>;
export type AdjustmentLayersPanelProps = ComponentProps<typeof AdjustmentLayersPanelComponent>;
export type CurvesEditorProps = ComponentProps<typeof CurvesEditorComponent>;
export type ControlSliderProps = ComponentProps<typeof ControlSliderComponent>;
export type SelectionOptionsBarProps = ComponentProps<typeof SelectionOptionsBarComponent>;
export type RefineEdgePanelProps = ComponentProps<typeof RefineEdgePanelComponent>;
export type MaskEdgeCheckProps = ComponentProps<typeof MaskEdgeCheckComponent>;
export type PathsPanelProps = ComponentProps<typeof PathsPanelComponent>;
export type SelectAndMaskWorkspaceProps = ComponentProps<typeof SelectAndMaskWorkspaceComponent>;
export type ContentAwareFillWorkspaceProps = ComponentProps<typeof ContentAwareFillWorkspaceComponent>;
export type ChannelsPanelProps = ComponentProps<typeof ChannelsPanelComponent>;
export type LayersPanelProps = ComponentProps<typeof LayersPanelComponent>;
export type ColorProfilePanelProps = ComponentProps<typeof ColorProfilePanelComponent>;
export type LayerEffectsPanelProps = ComponentProps<typeof LayerEffectsPanelComponent>;
export type BrushOptionsBarProps = ComponentProps<typeof BrushOptionsBarComponent>;
export type FreeTransformOptionsBarProps = ComponentProps<typeof FreeTransformOptionsBarComponent>;
export type ShapeOptionsBarProps = ComponentProps<typeof ShapeOptionsBarComponent>;
export type TypeOptionsBarProps = ComponentProps<typeof TypeOptionsBarComponent>;
export type ImageProviderEffectsPanelProps = ComponentProps<typeof ImageProviderEffectsPanelComponent>;

export {
	applyRegionMosaic,
	applyRegionBlur,
	resolveMosaicRegionBounds,
	type MosaicRegion,
	type MosaicImageDataLike
} from '@pixerate/editor/image-editor';
