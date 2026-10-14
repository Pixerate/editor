// Growth checks for "stays linear" (or "stays quadratic") tests.
//
// Absolute times depend on machine load, so these compare how run time grows when
// the input grows. A single slow sample (a GC pause, another process, a parallel
// test file) must not fail a test whose code is fine, while code that really grows
// faster must fail every time. So:
// - each sample repeats the work until it takes at least `minSampleMs`, so a
//   sub-millisecond run can't be swamped by one pause;
// - small and large are sampled alternately, `runs` times, keeping the best of each;
// - the whole measurement is retried up to `attempts` times while the ratio is at
//   or above `limit`, keeping the lowest ratio. A real complexity regression is
//   above the limit on every attempt.

export interface GrowthOptions {
  /** The ratio the test asserts it stays below; retrying stops once under it. */
  limit: number;
  /** Samples per size per attempt (best one kept). Default 5. */
  runs?: number;
  /** Measurements to try before giving up. Default 3. */
  attempts?: number;
  /** Repeat each sample until it takes at least this long. Default 10 ms. */
  minSampleMs?: number;
}

/** Ratio of the large workload's run time to the small one's (lowest of the attempts). */
export function measureGrowth(small: () => unknown, large: () => unknown, options: GrowthOptions): number {
  const { limit, runs = 5, attempts = 3, minSampleMs = 10 } = options;
  const repetitions = (fn: () => unknown) => {
    fn(); // warm up
    for (let n = 1; ; n *= 2) {
      const start = performance.now();
      for (let i = 0; i < n; i++) fn();
      if (performance.now() - start >= minSampleMs || n >= 1024) return n;
    }
  };
  const sample = (fn: () => unknown, n: number) => {
    const start = performance.now();
    for (let i = 0; i < n; i++) fn();
    return (performance.now() - start) / n;
  };
  const smallReps = repetitions(small);
  const largeReps = repetitions(large);
  let lowest = Infinity;
  for (let attempt = 0; attempt < attempts && lowest >= limit; attempt++) {
    let bestSmall = Infinity;
    let bestLarge = Infinity;
    for (let i = 0; i < runs; i++) {
      bestSmall = Math.min(bestSmall, sample(small, smallReps));
      bestLarge = Math.min(bestLarge, sample(large, largeReps));
    }
    lowest = Math.min(lowest, bestLarge / Math.max(bestSmall, 1e-3));
  }
  return lowest;
}

/**
 * Growth of `run` on `unit` repeated `small` vs `large` times (4× by default:
 * linear ≈ 4×, quadratic ≈ 16×), checked against a limit of 10.
 */
export function growthRatio(
  unit: string,
  run: (input: string) => unknown,
  { small = 16_000, large = 64_000, limit = 10 }: { small?: number; large?: number; limit?: number } = {},
): number {
  const smallInput = unit.repeat(small);
  const largeInput = unit.repeat(large);
  return measureGrowth(() => run(smallInput), () => run(largeInput), { limit });
}
