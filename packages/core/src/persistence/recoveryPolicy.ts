// Portions ported from filmcraft-main/apps/filmcraft-web/src/recovery_policy.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * What the caller should do now (see `RecoveryPolicy.tick`).
 *
 * - `writeSnapshot`: write the snapshot and a dirty meta for `revision`, then report with `written`.
 * - `writeClean`: write a clean meta (retire the snapshot), then report with `cleaned`.
 * - `wakeAfter`: nothing now; tick again after `delay` (same unit as `now`).
 */
export type RecoveryAction =
  | { type: "nothing" }
  | { type: "writeSnapshot"; revision: number }
  | { type: "writeClean" }
  | { type: "wakeAfter"; delay: number };

export interface RecoveryPolicyOptions {
  /**
   * Minimum time between snapshots of a changing document, in the unit of `now`
   * (default 5000, i.e. milliseconds).
   */
  interval?: number;
  /**
   * Wait before retrying after the `failures`-th consecutive failed write
   * (default: `interval`, as in FilmCraft). Use `exponentialBackoff` for doubling delays.
   */
  retryDelay?: (failures: number) => number;
}

export interface RecoveryTickOptions {
  /** Ignore the interval and any retry wait (e.g. on `pagehide`). */
  force?: boolean;
}

export interface RecoveryPolicy {
  /** Called whenever something may have changed, with the revisions and the current time. */
  tick(
    now: number,
    revision: number,
    savedRevision: number,
    options?: RecoveryTickOptions,
  ): RecoveryAction;
  /** The snapshot write for `revision` finished. */
  written(revision: number, ok: boolean, now: number): void;
  /** The clean-meta write finished. */
  cleaned(ok: boolean, now: number): void;
  /** Whether this session wrote a dirty snapshot that is not retired yet. */
  readonly ownsSnapshot: boolean;
  /** Consecutive failed writes (reset by a successful one). */
  readonly failures: number;
}

/**
 * Exponential backoff: `base`, `2·base`, `4·base`, … capped at `max`.
 * `failures` is 1 for the first failure.
 */
export function exponentialBackoff(
  failures: number,
  base = 1000,
  max = 30000,
): number {
  const exp = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(base * 2 ** exp, max);
}

/**
 * Pure state machine deciding when a crash-recovery snapshot is written or
 * retired. Deterministic: time is always passed in.
 *
 * - A dirty document is snapshotted at most every `interval`, once per revision.
 *   A write that fails is retried after `retryDelay`, without waiting for another edit.
 * - The snapshot is marked clean only if this session wrote it. A snapshot left by an
 *   earlier session (that was not restored) stays dirty, so it can still be recovered.
 * - An edit made while the clean write is in flight keeps the snapshot owned.
 */
export function createRecoveryPolicy(
  options: RecoveryPolicyOptions = {},
): RecoveryPolicy {
  const interval = options.interval ?? 5000;
  const retryDelay = options.retryDelay ?? (() => interval);
  const minWake = interval * 0.01;

  /** Revision whose snapshot was last written or is being written. */
  let lastRevision: number | null = null;
  let lastTime: number | null = null;
  /** Required gap after `lastTime`: the interval, or the retry delay after a failure. */
  let gap = interval;
  /** This session wrote a dirty meta that is not yet retired. */
  let ownsDirtyMeta = false;
  /** A clean-meta write is in flight. */
  let cleaning = false;
  /** Snapshot writes started so far, and how many had started when the clean write did. */
  let snapshots = 0;
  let snapshotsAtClean = 0;
  let failures = 0;

  const fail = (now: number) => {
    failures++;
    lastRevision = null;
    lastTime = now;
    gap = retryDelay(failures);
  };

  return {
    tick(now, revision, savedRevision, tickOptions) {
      const force = tickOptions?.force === true;
      const since = force || lastTime === null ? Infinity : now - lastTime;
      if (revision !== savedRevision) {
        if (lastRevision === revision) return { type: "nothing" };
        if (since >= gap) {
          lastRevision = revision;
          lastTime = now;
          ownsDirtyMeta = true;
          snapshots++;
          return { type: "writeSnapshot", revision };
        }
        return { type: "wakeAfter", delay: Math.max(gap - since, minWake) };
      }
      if (ownsDirtyMeta && !cleaning) {
        if (lastRevision !== null || since >= gap) {
          cleaning = true;
          snapshotsAtClean = snapshots;
          return { type: "writeClean" };
        }
        return { type: "wakeAfter", delay: Math.max(gap - since, minWake) };
      }
      return { type: "nothing" };
    },
    written(revision, ok, now) {
      if (ok) {
        if (lastRevision === revision) {
          failures = 0;
          gap = interval;
        }
      } else if (lastRevision === revision) {
        // retry after the delay, even if nothing else changes
        fail(now);
      }
    },
    cleaned(ok, now) {
      cleaning = false;
      if (ok) {
        ownsDirtyMeta = snapshots !== snapshotsAtClean;
        failures = 0;
        gap = interval;
      } else {
        fail(now);
      }
    },
    get ownsSnapshot() {
      return ownsDirtyMeta;
    },
    get failures() {
      return failures;
    },
  };
}
