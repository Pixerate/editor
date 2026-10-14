import { estimateJobProgress, type JobProgressEstimate } from "@pixerate/editor/generation";

export interface JobProgressOptions {
  startedAt: number | Date | string;
  expectedMs?: number;
  done?: boolean;
  /** Fixed current time (disables ticking; useful for SSR and tests). */
  now?: number | Date | string;
  /** Update interval while running in ms (default 1000). */
  intervalMs?: number;
}

export interface SvelteJobProgress {
  readonly progress: JobProgressEstimate;
  readonly percent: number;
  readonly label: string;
  /** Stops ticking. */
  destroy(): void;
}

/**
 * Ticking `estimateJobProgress` (Svelte 5 runes). Pass a getter so it follows
 * `$state` options; it ticks every `intervalMs` while not `done` and no fixed
 * `now` is given (browser only; nothing ticks during SSR). Call `destroy()`
 * when done (e.g. in `onDestroy`).
 */
export function createJobProgress(options: () => JobProgressOptions): SvelteJobProgress {
  let tick = $state(Date.now());
  const timer =
    typeof window !== "undefined"
      ? setInterval(() => {
          const current = options();
          if (!current.done && current.now === undefined) tick = Date.now();
        }, Math.max(16, options().intervalMs ?? 1000))
      : null;
  const progress = $derived.by(() => {
    const { startedAt, expectedMs, done, now } = options();
    return estimateJobProgress({ startedAt, expectedMs, done, now: now ?? tick });
  });
  return {
    get progress() {
      return progress;
    },
    get percent() {
      return progress.percent;
    },
    get label() {
      return progress.label;
    },
    destroy() {
      if (timer !== null) clearInterval(timer);
    },
  };
}
