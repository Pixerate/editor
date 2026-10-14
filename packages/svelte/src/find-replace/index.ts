import type { ComponentProps } from "svelte";
import type FindReplaceBarComponent from "./FindReplaceBar.svelte";

export { default as FindReplaceBar } from "./FindReplaceBar.svelte";
export * from "./findReplace.svelte.js";

export type FindReplaceBarProps = ComponentProps<typeof FindReplaceBarComponent>;
