/**
 * Tailwind classes shared by the image editor and its panels (same in the React and Svelte
 * packages). They use shadcn theme tokens (`background`, `foreground`, `muted`, `accent`,
 * `border`, `input`, `primary`, `destructive`), so the editor follows the host's light or dark theme.
 */

/** The editor's frame. */
export const imageEditorFrameClass = 'relative flex flex-col bg-background border border-border rounded-xl overflow-hidden shadow-sm text-foreground';
/** The bar above the canvas (tabs and global actions). */
export const imageEditorHeaderClass = 'flex flex-wrap items-center justify-between px-4 py-3 bg-muted/40 border-b border-border gap-3';
/** The tab strip. */
export const imageTabListClass = 'flex items-center gap-1 bg-background p-1 rounded-lg border border-border text-xs';
/** A tab of the editor, highlighted when `active`. */
export const imageTabClass = (active: boolean): string =>
  `px-3 py-1.5 rounded-md font-medium transition-colors ${active ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`;
/** A bordered button in the header (undo, redo, zoom…). */
export const imageHeaderButtonClass = 'p-1.5 rounded-lg border border-border bg-background text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed';
/** The primary action (export, apply). */
export const imagePrimaryButtonClass = 'rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow transition-colors disabled:opacity-50';
/** The side panel next to the canvas. */
export const imageSidebarClass = 'w-full md:w-80 bg-background border-t md:border-t-0 md:border-l border-border p-4 overflow-y-auto h-auto md:h-full md:max-h-[560px]';
/** The canvas area's background. */
export const imageCanvasAreaClass = 'bg-muted';
/** A small uppercase section title. */
export const imageSectionTitleClass = 'font-semibold text-foreground uppercase tracking-wider text-[11px]';
/** A section under a rule. */
export const imageSectionClass = 'border-t border-border pt-3';
/** A thin rule between groups of controls. */
export const imageDividerClass = 'h-px bg-border my-1';
/** A small secondary button. */
export const imageSmallButtonClass = 'px-2 py-1 rounded text-[11px] bg-muted text-foreground hover:bg-accent hover:text-accent-foreground self-start disabled:opacity-40';
/** A tiny button in a row (layer actions, effect actions). */
export const imageIconButtonClass = 'px-1.5 py-0.5 rounded text-[10px] bg-muted text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
/** An outlined tiny button. */
export const imageOutlineButtonClass = 'rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-40';
/** A toggle chip, filled when `on`. */
export const imageChipClass = (on: boolean): string =>
  `px-2 py-1 rounded text-[11px] ${on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-accent hover:text-accent-foreground'}`;
/** A bordered choice button, highlighted when `on`. */
export const imageChoiceClass = (on: boolean): string =>
  `border transition-colors ${on ? 'bg-primary/15 border-primary text-foreground' : 'bg-background border-border text-muted-foreground hover:text-foreground hover:bg-muted'}`;
/** A text or number field. */
export const imageFieldClass = 'rounded border border-input bg-background px-1 py-0.5 text-foreground';
/** A select. */
export const imageSelectClass = 'rounded border border-input bg-background px-1.5 py-1 text-foreground';
/** A colour input swatch. */
export const imageColorInputClass = 'h-6 w-8 rounded border border-border bg-transparent';
/** A full-width range slider. */
export const imageRangeClass = 'w-full accent-primary';
/** An error message. */
export const imageErrorClass = 'text-destructive';
/** An error banner. */
export const imageErrorBannerClass = 'border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive';
/** A spinner on a primary button. */
export const imageSpinnerClass = 'w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin';
