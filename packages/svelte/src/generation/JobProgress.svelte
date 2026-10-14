<script lang="ts">
  import { estimateJobProgress } from '@pixerate/editor/generation';

  interface Props {
    startedAt: number | Date | string;
    expectedMs?: number;
    done?: boolean;
    /** Fixed current time (disables ticking; useful for SSR and tests). */
    now?: number | Date | string;
    /** Update interval while running in ms (default 1000). */
    intervalMs?: number;
    /** Text shown before the time label, e.g. the model name. */
    title?: string;
    /** Extra classes for the root. */
    class?: string;
  }

  let { startedAt, expectedMs, done = false, now, intervalMs = 1000, title, class: className = '' }: Props = $props();

  let tick = $state(Date.now());
  const ticking = $derived(!done && now === undefined);

  $effect(() => {
    if (!ticking) return;
    tick = Date.now();
    const id = setInterval(() => (tick = Date.now()), Math.max(16, intervalMs));
    return () => clearInterval(id);
  });

  const progress = $derived(estimateJobProgress({ startedAt, expectedMs, done, now: now ?? tick }));
</script>

<!-- Headless-styled, time-based job progress: held at 95% until `done`, with a "~2m left" / "Almost done…" label. -->
<div class="flex flex-col gap-1 text-sm {className}" data-job-progress="" data-done={done ? '' : undefined}>
  <div class="flex items-center justify-between gap-2 text-muted-foreground">
    {#if title}<span class="truncate text-foreground">{title}</span>{/if}
    <span data-job-progress-label="" aria-live="polite">{progress.label}</span>
  </div>
  <div
    role="progressbar"
    aria-label={title ?? 'Generation progress'}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={progress.percent}
    aria-valuetext="{progress.percent}%, {progress.label}"
    class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
  >
    <div
      class="h-full rounded-full bg-primary transition-[width] duration-500"
      style="width: {progress.percent}%; background: var(--primary, currentColor);"
    ></div>
  </div>
</div>
