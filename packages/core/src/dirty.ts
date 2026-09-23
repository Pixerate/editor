/**
 * Compares two values for structural equality.
 * Handles primitives, objects, arrays, and null/undefined.
 */
export function defaultIsEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  // Fast path for arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!defaultIsEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  const keysA = Object.keys(a) as (keyof T)[];
  const keysB = Object.keys(b) as (keyof T)[];

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!defaultIsEqual(a[key], b[key])) return false;
  }

  return true;
}

export interface DirtyTrackerOptions<T> {
  isEqual?: (a: T, b: T) => boolean;
}

/**
 * Tracks a baseline value and determines if the current state is dirty (modified).
 */
export class DirtyTracker<T = unknown> {
  private baseline: T;
  private readonly isEqual: (a: T, b: T) => boolean;

  constructor(
    initialBaseline: T,
    options?: DirtyTrackerOptions<T> | ((a: T, b: T) => boolean),
  ) {
    this.baseline = initialBaseline;
    if (typeof options === "function") {
      this.isEqual = options;
    } else {
      this.isEqual = options?.isEqual ?? defaultIsEqual;
    }
  }

  /**
   * Returns current baseline value.
   */
  public getBaseline(): T {
    return this.baseline;
  }

  /**
   * Sets a new baseline value without triggering any dirty state.
   */
  public setBaseline(value: T): void {
    this.baseline = value;
  }

  /**
   * Checks whether the given value differs from the baseline.
   */
  public isDirty(current: T): boolean {
    return !this.isEqual(this.baseline, current);
  }

  /**
   * Resets the baseline to the provided current value (or clears dirty status).
   */
  public reset(current: T): void {
    this.baseline = current;
  }
}

/**
 * Creates a DirtyTracker instance.
 */
export function createDirtyTracker<T>(
  initialBaseline: T,
  options?: DirtyTrackerOptions<T> | ((a: T, b: T) => boolean),
): DirtyTracker<T> {
  return new DirtyTracker(initialBaseline, options);
}
