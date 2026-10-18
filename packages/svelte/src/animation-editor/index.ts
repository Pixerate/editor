import type { ComponentProps } from "svelte";
import type AnimationEditorComponent from "./AnimationEditor.svelte";
import type AnimationStageComponent from "./AnimationStage.svelte";
import type ShotTimelineComponent from "./ShotTimeline.svelte";

export { default as AnimationEditor } from "./AnimationEditor.svelte";
export { default as AnimationStage } from "./AnimationStage.svelte";
export { default as ShotTimeline } from "./ShotTimeline.svelte";
export * from "./createAnimationEditor.svelte.js";

export type AnimationEditorProps = ComponentProps<typeof AnimationEditorComponent>;
export type AnimationStageProps = ComponentProps<typeof AnimationStageComponent>;
export type ShotTimelineProps = ComponentProps<typeof ShotTimelineComponent>;
