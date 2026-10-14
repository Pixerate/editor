import type { ComponentProps } from "svelte";
import type CommentsPanelComponent from "./CommentsPanel.svelte";
import type ReviewToolbarComponent from "./ReviewToolbar.svelte";
import type CommentButtonComponent from "./CommentButton.svelte";
import type TrackedChangesListComponent from "./TrackedChangesList.svelte";

export { default as TrackedChangesList } from "./TrackedChangesList.svelte";
export type TrackedChangesListProps = ComponentProps<typeof TrackedChangesListComponent>;
export { default as CommentsPanel } from "./CommentsPanel.svelte";
export { default as ReviewToolbar } from "./ReviewToolbar.svelte";
export { default as CommentButton } from "./CommentButton.svelte";
export * from "./review.svelte.js";
export * from "./documentCompare.svelte.js";

export type CommentsPanelProps = ComponentProps<typeof CommentsPanelComponent>;
export type ReviewToolbarProps = ComponentProps<typeof ReviewToolbarComponent>;
export type CommentButtonProps = ComponentProps<typeof CommentButtonComponent>;
