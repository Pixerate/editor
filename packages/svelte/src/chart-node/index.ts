import type { ComponentProps } from "svelte";
import type ChartNodeViewComponent from "./ChartNodeView.svelte";

export { default as ChartNodeView } from "./ChartNodeView.svelte";
export * from "./createChartNodeView.svelte.js";

export type ChartNodeViewProps = ComponentProps<typeof ChartNodeViewComponent>;
