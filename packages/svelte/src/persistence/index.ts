import type { ComponentProps } from "svelte";
import type RecoveryPromptComponent from "./RecoveryPrompt.svelte";

export { default as RecoveryPrompt } from "./RecoveryPrompt.svelte";
export * from "./autosave.svelte.js";
export * from "./editorAutosave.svelte.js";

export type RecoveryPromptProps = ComponentProps<typeof RecoveryPromptComponent>;
