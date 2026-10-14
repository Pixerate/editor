import type { ComponentProps } from "svelte";
import type CommandPaletteComponent from "./CommandPalette.svelte";

export { default as CommandPalette } from "./CommandPalette.svelte";
export * from "./palette.svelte.js";
export * from "./commandShortcuts.svelte.js";

export type CommandPaletteProps = ComponentProps<typeof CommandPaletteComponent>;
