// Measures how run time grows when the input grows 4x, for "stays linear" tests.
// Linear is ~4x, quadratic ~16x. Absolute times depend on machine load, so this
// compares growth instead: best of five runs at each size, at sizes large enough
// to take milliseconds, and the lowest ratio of three attempts. A GC pause or a
// busy machine (parallel test runs) can't make a linear scan look quadratic,
// while a real quadratic one still fails every attempt.
export function growthRatio(
  unit: string,
  run: (input: string) => unknown,
  { small = 16_000, large = 64_000 }: { small?: number; large?: number } = {},
): number {
  const time = (n: number) => {
    const input = unit.repeat(n);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run(input);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  time(1000);
  let ratio = Infinity;
  for (let attempt = 0; attempt < 3 && ratio >= 10; attempt++) {
    ratio = Math.min(ratio, time(large) / Math.max(time(small), 1));
  }
  return ratio;
}
