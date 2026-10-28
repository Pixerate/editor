import { parameterThemeStyleText } from "@pixerate/editor/parameters";

// Class names shared by the parameter controls (the same as the React package's).
export const parameterInputClass =
  "h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";
export const parameterButtonClass =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50";
export const parameterRangeClass =
  "h-4 w-full min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50";

/** Inline theme styles (`--pixerate-parameter-*` tokens with host fallbacks), shared with React through core. */
export const parameterInputStyle = parameterThemeStyleText("input");
export const parameterSelectStyle = parameterThemeStyleText("select");
/** Text and border only, so the button classes' `hover:` background still applies. */
export const parameterButtonStyle = parameterThemeStyleText("button");
export const parameterRangeStyle = parameterThemeStyleText("range");
