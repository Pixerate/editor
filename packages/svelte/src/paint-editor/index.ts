import type { ComponentProps } from 'svelte';
import type PaintEditorComponent from './PaintEditor.svelte';
import type PaintCanvasComponent from './PaintCanvas.svelte';
import type PaintToolbarComponent from './PaintToolbar.svelte';
import type BrushPanelComponent from './BrushPanel.svelte';
import type PaperPanelComponent from './PaperPanel.svelte';
import type ColorPanelComponent from './ColorPanel.svelte';
import type PaintLayersPanelComponent from './PaintLayersPanel.svelte';
import type WetPanelComponent from './WetPanel.svelte';
import type StickerPanelComponent from './StickerPanel.svelte';
import type PaintGradientEditorComponent from './PaintGradientEditor.svelte';

export { default as PaintEditor } from './PaintEditor.svelte';
export { default as PaintCanvas } from './PaintCanvas.svelte';
export { default as PaintToolbar } from './PaintToolbar.svelte';
export { default as BrushPanel } from './BrushPanel.svelte';
export { default as PaperPanel } from './PaperPanel.svelte';
export { default as ColorPanel } from './ColorPanel.svelte';
export { default as PaintLayersPanel } from './PaintLayersPanel.svelte';
export { default as WetPanel } from './WetPanel.svelte';
export { default as StickerPanel } from './StickerPanel.svelte';
export { default as PaintGradientEditor } from './PaintGradientEditor.svelte';
export { default as PaintSlider } from './PaintSlider.svelte';
export { default as PaintPresenceLayer } from './PaintPresenceLayer.svelte';
export { createPaintDirector, createReactivePaintEditor, paintEditorState } from './paintEditorRune.svelte.js';

export type PaintEditorProps = ComponentProps<typeof PaintEditorComponent>;
export type PaintCanvasProps = ComponentProps<typeof PaintCanvasComponent>;
export type PaintToolbarProps = ComponentProps<typeof PaintToolbarComponent>;
export type BrushPanelProps = ComponentProps<typeof BrushPanelComponent>;
export type PaperPanelProps = ComponentProps<typeof PaperPanelComponent>;
export type ColorPanelProps = ComponentProps<typeof ColorPanelComponent>;
export type PaintLayersPanelProps = ComponentProps<typeof PaintLayersPanelComponent>;
export type WetPanelProps = ComponentProps<typeof WetPanelComponent>;
export type StickerPanelProps = ComponentProps<typeof StickerPanelComponent>;

export type PaintGradientEditorProps = ComponentProps<typeof PaintGradientEditorComponent>;
