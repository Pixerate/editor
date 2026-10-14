import type { ComponentProps } from "svelte";
import type TokensPanelComponent from "./TokensPanel.svelte";

export { default as TokensPanel } from "./TokensPanel.svelte";
export { default as TokenSwatch } from "./TokenSwatch.svelte";
export * from "./createTokens.svelte.js";

export type TokensPanelProps = ComponentProps<typeof TokensPanelComponent>;
