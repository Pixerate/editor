import type { ComponentProps } from "svelte";
import type EffectsBrowserComponent from "./EffectsBrowser.svelte";
import type EffectParametersComponent from "./EffectParameters.svelte";
import type EffectThumbnailComponent from "./EffectThumbnail.svelte";

export { default as EffectsBrowser } from "./EffectsBrowser.svelte";
export { default as EffectParameters } from "./EffectParameters.svelte";
export { default as EffectThumbnail } from "./EffectThumbnail.svelte";
export * from "./effects.svelte.js";

export type EffectsBrowserProps = ComponentProps<typeof EffectsBrowserComponent>;
export type EffectParametersProps = ComponentProps<typeof EffectParametersComponent>;
export type EffectThumbnailProps = ComponentProps<typeof EffectThumbnailComponent>;
