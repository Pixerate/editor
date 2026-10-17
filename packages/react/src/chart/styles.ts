// Class names shared by the chart components (the same as the Svelte package's).
export const chartInputClass =
  'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50';
export const chartButtonClass =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50';
export const chartIconButtonClass =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40';
export const chartSegmentClass = (active: boolean) =>
  `inline-flex h-7 flex-1 items-center justify-center rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
  }`;
export const chartLabelClass = 'text-[11px] font-medium text-muted-foreground';
export const chartSectionClass = 'space-y-2 border-b border-border pb-3 last:border-b-0';
export const chartCellClass =
  'h-7 w-full min-w-[4.5rem] bg-transparent px-2 text-right text-xs tabular-nums text-foreground focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary';
