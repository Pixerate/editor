import type { ComponentProps } from "svelte";
import type ChartCanvasComponent from "./ChartCanvas.svelte";
import type ChartDataGridComponent from "./ChartDataGrid.svelte";
import type ChartEditorComponent from "./ChartEditor.svelte";
import type ChartInspectorComponent from "./ChartInspector.svelte";

export { default as ChartEditor } from "./ChartEditor.svelte";
export { default as ChartCanvas } from "./ChartCanvas.svelte";
export { default as ChartDataGrid } from "./ChartDataGrid.svelte";
export { default as ChartInspector } from "./ChartInspector.svelte";
export { default as ChartCommitInput } from "./ChartCommitInput.svelte";
export type { ChartInspectorSection } from "./ChartInspector.svelte";
export * from "./createChartEditor.svelte.js";
export * from "./styles.js";

export type ChartCanvasProps = ComponentProps<typeof ChartCanvasComponent>;
export type ChartDataGridProps = ComponentProps<typeof ChartDataGridComponent>;
export type ChartEditorProps = ComponentProps<typeof ChartEditorComponent>;
export type ChartInspectorProps = ComponentProps<typeof ChartInspectorComponent>;
