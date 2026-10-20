// Work counts for "stays linear" tests whose steps are private module functions, so
// `vi.spyOn` can't reach them.
//
// Counts the array elements `run` visits through `for…of`, spreads and `Array.from` on
// arrays (the array iterator's `next`), the callback methods (map, filter, forEach, …)
// and the scanning methods (indexOf, includes, …). The count is exact and the same on
// every run, so a test can compare two input sizes with a tight limit where wall-clock
// ratios flake on loaded CI runners. Loops written with an index (`for (let i …)`) and
// `sort` are not counted.

const CALLBACK_METHODS = ["forEach", "map", "filter", "reduce", "some", "every", "find", "findIndex", "flatMap"] as const;
const SCAN_METHODS = ["indexOf", "lastIndexOf", "includes"] as const;

type AnyMethod = (this: unknown[], ...args: unknown[]) => unknown;

/** Array elements `run` visits (see the file comment for what is counted). */
export function arrayVisits(run: () => void): number {
  let visits = 0;
  const proto = Array.prototype as unknown as Record<string, AnyMethod>;
  const iterator = Object.getPrototypeOf([][Symbol.iterator]()) as { next: AnyMethod };
  const next = iterator.next;
  const originals = [...CALLBACK_METHODS, ...SCAN_METHODS].map((name) => [name, proto[name]] as const);
  for (const name of CALLBACK_METHODS) {
    const original = proto[name];
    proto[name] = function (this: unknown[], fn: unknown, second?: unknown) {
      const counted = function (this: unknown, ...args: unknown[]) {
        visits++;
        return (fn as AnyMethod).apply(this as unknown[], args);
      };
      // No spread (it would count itself); `reduce` without a seed must stay seedless.
      return arguments.length > 1 ? original.call(this, counted, second) : original.call(this, counted);
    };
  }
  for (const name of SCAN_METHODS) {
    const original = proto[name];
    proto[name] = function (this: unknown[], ...args: unknown[]) {
      visits += this.length;
      return original.apply(this, args);
    };
  }
  // Last, so the loops above aren't counted.
  iterator.next = function (this: unknown[]) {
    visits++;
    return next.call(this);
  };
  try {
    run();
    return visits;
  } finally {
    iterator.next = next;
    for (const [name, original] of originals) proto[name] = original;
  }
}
