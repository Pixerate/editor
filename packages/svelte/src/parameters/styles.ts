// Class names shared by the parameter controls (the same as the React package's).
export const parameterInputClass =
  "h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";
export const parameterButtonClass =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50";
export const parameterRangeClass =
  "h-4 w-full min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50";

/** CSS variable tokens with fallbacks so controls follow the host's theme. */
export const parameterInputStyle =
  "background-color: var(--pixerate-parameter-input-bg, var(--background, transparent)); color: var(--pixerate-parameter-input-fg, var(--foreground, inherit)); border-color: var(--pixerate-parameter-input-border, var(--input, var(--border, currentColor)));";
export const parameterButtonStyle =
  "background-color: var(--pixerate-parameter-button-bg, var(--background, transparent)); color: var(--pixerate-parameter-button-fg, var(--foreground, inherit)); border-color: var(--pixerate-parameter-button-border, var(--input, var(--border, currentColor)));";
export const parameterSelectStyle =
  "background-color: var(--pixerate-parameter-select-bg, var(--pixerate-parameter-input-bg, var(--background, transparent))); color: var(--pixerate-parameter-select-fg, var(--pixerate-parameter-input-fg, var(--foreground, inherit))); border-color: var(--pixerate-parameter-select-border, var(--pixerate-parameter-input-border, var(--input, var(--border, currentColor))));";
export const parameterRangeStyle =
  "accent-color: var(--pixerate-parameter-slider-accent, var(--primary, currentColor));";

