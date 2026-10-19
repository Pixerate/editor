import type { ComponentProps } from "svelte";
import type VideoEditorComponent from "./VideoEditor.svelte";
import type VideoPreviewComponent from "./VideoPreview.svelte";
import type VideoTransportComponent from "./VideoTransport.svelte";
import type VideoTimelineComponent from "./VideoTimeline.svelte";
import type ClipInspectorComponent from "./ClipInspector.svelte";
import type MediaBinComponent from "./MediaBin.svelte";
import type TranscriptPanelComponent from "./TranscriptPanel.svelte";

export { default as VideoEditor } from "./VideoEditor.svelte";
export { default as VideoPreview } from "./VideoPreview.svelte";
export { default as VideoTransport } from "./VideoTransport.svelte";
export { default as VideoTimeline } from "./VideoTimeline.svelte";
export { default as ClipInspector } from "./ClipInspector.svelte";
export { default as MediaBin } from "./MediaBin.svelte";
export { default as TranscriptPanel } from "./TranscriptPanel.svelte";
export * from "./createVideoEditor.svelte.js";

export type VideoEditorProps = ComponentProps<typeof VideoEditorComponent>;
export type VideoPreviewProps = ComponentProps<typeof VideoPreviewComponent>;
export type VideoTransportProps = ComponentProps<typeof VideoTransportComponent>;
export type VideoTimelineProps = ComponentProps<typeof VideoTimelineComponent>;
export type ClipInspectorProps = ComponentProps<typeof ClipInspectorComponent>;
export type MediaBinProps = ComponentProps<typeof MediaBinComponent>;
export type TranscriptPanelProps = ComponentProps<typeof TranscriptPanelComponent>;
