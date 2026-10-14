// Portions ported from soundcraft-main/crates/engine/src/lib.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

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
  /**
   * Equality check. When `normalize` is set it receives the normalized values.
   */
  isEqual?: (a: T, b: T) => boolean;
  /**
   * Projects a value onto the part that counts as "the document" before
   * comparing, e.g. `({ selection, viewport, ...doc }) => doc` so that
   * selecting, scrolling or zooming never marks the document dirty.
   */
  normalize?: (value: T) => unknown;
}

type Thenable = { then: (...args: any[]) => any };

const isThenable = (value: unknown): value is Thenable =>
  !!value &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as Thenable).then === "function";

/**
 * Tracks a baseline (saved) value and determines whether the current value is
 * dirty (modified).
 *
 * Stateless use: `isDirty(current)`. Stateful use: feed values with
 * `update(current, revision?)`, read `dirty`, `subscribe` to changes, call
 * `markClean()` after saving and wrap programmatic loads in `suppress(fn)`.
 */
export class DirtyTracker<T = unknown> {
  private baseline: T;
  private readonly isEqual: (a: T, b: T) => boolean;
  private readonly normalize?: (value: T) => unknown;
  private normalizedBaseline: { value: unknown } | null = null;
  /** `isDirty` result as of a revision (and baseline version). */
  private cache: { revision: number; baseline: number; dirty: boolean } | null =
    null;
  private baselineVersion = 0;
  private suppressDepth = 0;
  private hasValue = false;
  private lastValue: T | undefined;
  private dirtyState = false;
  private listeners = new Set<(dirty: boolean) => void>();

  constructor(
    initialBaseline: T,
    options?: DirtyTrackerOptions<T> | ((a: T, b: T) => boolean),
  ) {
    this.baseline = initialBaseline;
    if (typeof options === "function") {
      this.isEqual = options;
    } else {
      this.isEqual = options?.isEqual ?? defaultIsEqual;
      this.normalize = options?.normalize;
    }
  }

  /**
   * Returns current baseline value.
   */
  public getBaseline(): T {
    return this.baseline;
  }

  private changeBaseline(value: T): void {
    this.baseline = value;
    this.baselineVersion++;
    this.normalizedBaseline = null;
    this.cache = null;
  }

  /**
   * Sets a new baseline value without triggering any dirty state.
   * If a value is being tracked (`update`), `dirty` is recomputed against it.
   */
  public setBaseline(value: T): void {
    this.changeBaseline(value);
    if (this.hasValue) {
      this.setDirtyState(this.compare(this.lastValue as T));
    }
  }

  private compare(current: T): boolean {
    if (!this.normalize) return !this.isEqual(this.baseline, current);
    this.normalizedBaseline ??= { value: this.normalize(this.baseline) };
    return !this.isEqual(
      this.normalizedBaseline.value as T,
      this.normalize(current) as T,
    );
  }

  /**
   * Checks whether the given value differs from the baseline.
   * With a `revision` (e.g. `HistoryManager.getRevision()`), the result is
   * cached and reused for the same revision until the baseline changes.
   */
  public isDirty(current: T, revision?: number): boolean {
    if (revision === undefined) return this.compare(current);
    const cache = this.cache;
    if (
      cache &&
      cache.revision === revision &&
      cache.baseline === this.baselineVersion
    ) {
      return cache.dirty;
    }
    const dirty = this.compare(current);
    this.cache = { revision, baseline: this.baselineVersion, dirty };
    return dirty;
  }

  /**
   * Resets the baseline to the provided current value (or clears dirty status).
   */
  public reset(current: T): void {
    this.changeBaseline(current);
    this.hasValue = true;
    this.lastValue = current;
    this.setDirtyState(false);
  }

  /**
   * Records the current value and returns whether it is dirty. While
   * suppressed (`suppress`), the value becomes the new baseline instead, so
   * programmatic loads and restores never mark the document dirty.
   */
  public update(current: T, revision?: number): boolean {
    this.hasValue = true;
    this.lastValue = current;
    if (this.suppressDepth > 0) {
      this.changeBaseline(current);
      this.setDirtyState(false);
      return false;
    }
    const dirty = this.isDirty(current, revision);
    this.setDirtyState(dirty);
    return dirty;
  }

  /** Whether the last value passed to `update` differs from the baseline. */
  public get dirty(): boolean {
    return this.dirtyState;
  }

  /** Whether `suppress` is currently running. */
  public get suppressed(): boolean {
    return this.suppressDepth > 0;
  }

  /**
   * Marks the document saved: `current` (default: the last value passed to
   * `update`) becomes the baseline.
   */
  public markClean(...args: [] | [current: T]): void {
    if (args.length > 0) {
      this.reset(args[0] as T);
    } else if (this.hasValue) {
      this.reset(this.lastValue as T);
    } else {
      this.setDirtyState(false);
    }
  }

  /**
   * Runs `fn` without marking anything dirty: every `update` during it
   * rebaselines. Re-entrant (depth counter). If `fn` returns a promise, the
   * suppression lasts until it settles.
   */
  public suppress<R>(fn: () => R): R {
    this.suppressDepth++;
    let result: R;
    try {
      result = fn();
    } catch (error) {
      this.suppressDepth--;
      throw error;
    }
    if (isThenable(result)) {
      const release = () => {
        this.suppressDepth--;
      };
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          release();
          return value;
        },
        (error) => {
          release();
          throw error;
        },
      ) as unknown as R;
    }
    this.suppressDepth--;
    return result;
  }

  /**
   * Subscribes to changes of `dirty`. The listener is called immediately with
   * the current value. Returns an unsubscribe function.
   */
  public subscribe(listener: (dirty: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.dirtyState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setDirtyState(dirty: boolean): void {
    if (dirty === this.dirtyState) return;
    this.dirtyState = dirty;
    this.listeners.forEach((listener) => {
      try {
        listener(dirty);
      } catch (err) {
        console.error("[DirtyTracker] Error in listener:", err);
      }
    });
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

/**
 * Runs `fn` with dirty tracking suppressed (see `DirtyTracker.suppress`).
 */
export function withoutDirty<R>(tracker: DirtyTracker<any>, fn: () => R): R {
  return tracker.suppress(fn);
}

/** Minimal history surface used by `bindDirtyToHistory` (`HistoryManager` satisfies it). */
export interface DirtyHistorySource {
  subscribe(listener: (...args: any[]) => void): () => void;
  getRevision?(): number;
}

export interface BindDirtyToHistoryOptions<T> extends DirtyTrackerOptions<T> {
  history: DirtyHistorySource;
  /** Reads the current document value. */
  getValue: () => T;
  /** Existing tracker to drive (default: a new one baselined on `getValue()`). */
  tracker?: DirtyTracker<T>;
}

export interface HistoryDirtyBinding<T> {
  readonly tracker: DirtyTracker<T>;
  /** Whether the document differs from the saved baseline. */
  readonly dirty: boolean;
  /** Marks the current value as saved. */
  markClean(): void;
  /** Runs `fn` (e.g. a load or restore) without marking the document dirty. */
  suppress<R>(fn: () => R): R;
  /** Re-reads the value after a change made outside the history. */
  refresh(): boolean;
  subscribe(listener: (dirty: boolean) => void): () => void;
  /** Stops listening to the history. */
  destroy(): void;
}

/**
 * Keeps a `DirtyTracker` in step with a `HistoryManager`: every history change
 * re-reads the value (cached per history revision), so undoing back to the
 * saved state makes the document clean again.
 */
export function bindDirtyToHistory<T>(
  options: BindDirtyToHistoryOptions<T>,
): HistoryDirtyBinding<T> {
  const { history, getValue } = options;
  const tracker =
    options.tracker ??
    new DirtyTracker<T>(getValue(), {
      isEqual: options.isEqual,
      normalize: options.normalize,
    });
  const unsubscribe = history.subscribe(() => {
    tracker.update(getValue(), history.getRevision?.());
  });
  return {
    tracker,
    get dirty() {
      return tracker.dirty;
    },
    markClean: () => tracker.markClean(getValue()),
    suppress: <R>(fn: () => R): R => {
      // The loaded value becomes the baseline even if the load never touched the history.
      const rebaseline = () => {
        if (!tracker.suppressed) tracker.reset(getValue());
      };
      const result = tracker.suppress(fn);
      if (isThenable(result)) {
        return (result as unknown as Promise<unknown>).then((value) => {
          rebaseline();
          return value;
        }) as unknown as R;
      }
      rebaseline();
      return result;
    },
    refresh: () => tracker.update(getValue()),
    subscribe: (listener) => tracker.subscribe(listener),
    destroy: unsubscribe,
  };
}
