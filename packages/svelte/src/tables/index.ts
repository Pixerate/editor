import type { ComponentProps } from "svelte";
import type TableToolbarComponent from "./TableToolbar.svelte";
import type InsertTableGridComponent from "./InsertTableGrid.svelte";
import type TableBubbleMenuComponent from "./TableBubbleMenu.svelte";

export { default as TableToolbar } from "./TableToolbar.svelte";
export { default as InsertTableGrid } from "./InsertTableGrid.svelte";
export { default as TableBubbleMenu } from "./TableBubbleMenu.svelte";
export * from "./tableMenu.svelte.js";

export type TableToolbarProps = ComponentProps<typeof TableToolbarComponent>;
export type InsertTableGridProps = ComponentProps<typeof InsertTableGridComponent>;
export type TableBubbleMenuProps = ComponentProps<typeof TableBubbleMenuComponent>;
