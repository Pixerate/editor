// Portions ported from filmcraft-main/apps/filmcraft-web/src/recovery.rs and
// craft-libs-main/crates/settings/src/store.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.

import {
  createRecoveryPolicy,
  exponentialBackoff,
  type RecoveryAction,
  type RecoveryPolicy,
} from "./recoveryPolicy";
import type { StorageAdapter } from "./storage";

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface AutosaveStatusInfo {
  status: AutosaveStatus;
  /** Last write error (while `status` is `"error"`). */
  error: unknown;
  /** Consecutive failed writes. */
  failures: number;
  /** When the next attempt is due (`now()` units), while waiting. */
  nextAttemptAt: number | null;
  /** When the last snapshot was written (`now()` units). */
  lastSavedAt: number | null;
  /** Whether `ready()` was called. */
  ready: boolean;
}

/** Stored next to the snapshot (`<key>:meta`). */
export interface RecoveryMeta {
  dirty: boolean;
  revision?: number;
  /** `Date.now()` of the write. */
  time?: number;
  /** Document name, for the "Restore unsaved changes from …?" prompt. */
  name?: string;
}

export interface AutosaveRecovery<T = unknown> {
  /** The parsed snapshot (`undefined` when `deserialize` threw; see `error`). */
  snapshot: T | undefined;
  /** The stored text. */
  text: string;
  meta: RecoveryMeta & { dirty: true };
  error?: unknown;
}

export interface AutosaveControllerOptions<T> {
  storage: StorageAdapter;
  /** Snapshot key; the meta lives at `<key>:meta`. */
  key: string;
  /** Reads the current document. */
  getSnapshot: () => T;
  /** Default `JSON.stringify`. */
  serialize?: (snapshot: T) => string;
  /** Default `JSON.parse` (used by `checkRecovery`). */
  deserialize?: (text: string) => T;
  /** Current document revision; must change on every edit. */
  revision: () => number;
  /** Revision of the last explicit save (equal to `revision()` when clean). */
  savedRevision: () => number;
  /** Document name stored in the meta. */
  name?: string | (() => string | undefined);
  onStatus?: (info: AutosaveStatusInfo) => void;
  /** Minimum time between snapshots while edits keep coming (default 5000 ms). */
  interval?: number;
  /** Quiet time after the last edit before a snapshot is written (default 1000 ms). */
  debounceMs?: number;
  /** First retry delay after a failed write; doubles per failure (default 1000 ms). */
  retryBaseMs?: number;
  /** Retry delay cap (default 30000 ms). */
  retryMaxMs?: number;
  /** Clock for scheduling (default `Date.now`). */
  now?: () => number;
  /** Wall clock stored in the meta (default `Date.now`). */
  wallClock?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: any) => void;
  /** Start hydrated, i.e. as if `ready()` was already called (default `false`). */
  ready?: boolean;
}

export interface AutosaveController<T = unknown> {
  /** Current status. */
  getStatus(): AutosaveStatusInfo;
  /** Listener is called on every status change (not immediately). */
  subscribe(listener: (info: AutosaveStatusInfo) => void): () => void;
  /** Call after every change (edit, undo, save). Cheap; the write is scheduled. */
  notify(): void;
  /** Lifts the hydration gate: no snapshot is written before this. */
  ready(): void;
  readonly isReady: boolean;
  /**
   * Writes a snapshot of unsaved changes right away, skipping the debounce, the
   * interval and retry waits. Use on `pagehide` / `visibilitychange`. Resolves
   * once the write settled.
   */
  flushNow(): Promise<void>;
  /**
   * Call after the document was saved (`savedRevision()` now equals
   * `revision()`): retires the snapshot only if this session wrote it.
   */
  markClean(): Promise<void>;
  /**
   * A dirty snapshot left by an earlier session, or `null`. Returns `null` once
   * this session has written its own snapshot.
   */
  checkRecovery(): Promise<AutosaveRecovery<T> | null>;
  /** Deletes an earlier session's snapshot. No-op once this session wrote its own. */
  discardRecovery(): Promise<boolean>;
  /** Runs one scheduling step now (normally driven by `notify` and timers). */
  tick(): void;
  /** Resolves when no write is in flight. */
  whenIdle(): Promise<void>;
  /** Stops all timers. Pending changes are not written; call `flushNow` first. */
  destroy(): void;
}

export const recoveryMetaKey = (key: string) => `${key}:meta`;

/**
 * Text for a recovery prompt: "Restore unsaved changes from <time>?" (the
 * React and Svelte `RecoveryPrompt` components use it).
 */
export function formatRecoveryMessage(
  meta: Pick<RecoveryMeta, "time">,
  formatTime: (time: number) => string = (time) => new Date(time).toLocaleString(),
): string {
  return typeof meta.time === "number" && Number.isFinite(meta.time)
    ? `Restore unsaved changes from ${formatTime(meta.time)}?`
    : "Restore unsaved changes?";
}

/**
 * Debounced autosave of crash-recovery snapshots.
 *
 * - Hydration gate: nothing is written until `ready()`, so loading a document
 *   (or deciding about a recovered one) never overwrites the previous session's snapshot.
 * - A snapshot is written `debounceMs` after the last edit, and at least every
 *   `interval` while edits keep coming; never twice for one revision.
 * - Failed writes are retried with exponential backoff (`retryBaseMs` doubling up to
 *   `retryMaxMs`) without waiting for another edit.
 * - The snapshot is written before its dirty meta, so the meta never points at a
 *   missing snapshot. Once saved, the meta is marked clean only if this session
 *   wrote the snapshot (`createRecoveryPolicy`).
 */
export function createAutosaveController<T>(
  options: AutosaveControllerOptions<T>,
): AutosaveController<T> {
  const {
    storage,
    key,
    getSnapshot,
    revision,
    savedRevision,
    interval = 5000,
    debounceMs = 1000,
    retryBaseMs = 1000,
    retryMaxMs = 30000,
  } = options;
  const serialize = options.serialize ?? ((value: T) => JSON.stringify(value));
  const deserialize = options.deserialize ?? ((text: string) => JSON.parse(text) as T);
  const now = options.now ?? (() => Date.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const setTimer =
    options.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((handle: any) => globalThis.clearTimeout(handle));
  const metaKey = recoveryMetaKey(key);

  const policy: RecoveryPolicy = createRecoveryPolicy({
    interval,
    retryDelay: (failures) => exponentialBackoff(failures, retryBaseMs, retryMaxMs),
  });

  let hydrated = options.ready === true;
  let destroyed = false;
  let timer: unknown = null;
  let timerDue = Infinity;
  let inflight: Promise<void> | null = null;
  let observedRevision = revision();
  let lastChangeAt: number | null = null;
  let pendingSince: number | null = null;
  let forceNext = false;
  let info: AutosaveStatusInfo = {
    status: "idle",
    error: null,
    failures: 0,
    nextAttemptAt: null,
    lastSavedAt: null,
    ready: hydrated,
  };
  const listeners = new Set<(info: AutosaveStatusInfo) => void>();

  const setInfo = (patch: Partial<AutosaveStatusInfo>) => {
    const next = { ...info, ...patch, failures: policy.failures, ready: hydrated };
    if (
      next.status === info.status &&
      next.error === info.error &&
      next.failures === info.failures &&
      next.nextAttemptAt === info.nextAttemptAt &&
      next.lastSavedAt === info.lastSavedAt &&
      next.ready === info.ready
    ) {
      return;
    }
    info = next;
    options.onStatus?.(info);
    listeners.forEach((listener) => {
      try {
        listener(info);
      } catch (error) {
        console.error("[autosave] Error in status listener:", error);
      }
    });
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    timerDue = Infinity;
  };

  const schedule = (delay: number) => {
    if (destroyed) return;
    const due = now() + Math.max(0, delay);
    if (timer !== null && timerDue <= due) return;
    cancelTimer();
    timerDue = due;
    timer = setTimer(() => {
      timer = null;
      timerDue = Infinity;
      tick();
    }, Math.max(0, delay));
  };

  const observe = (t: number) => {
    const rev = revision();
    if (rev !== observedRevision) {
      observedRevision = rev;
      lastChangeAt = t;
      pendingSince ??= t;
    }
    return rev;
  };

  const docName = () =>
    typeof options.name === "function" ? options.name() : options.name;

  const run = (action: RecoveryAction, rev: number) => {
    if (action.type === "writeSnapshot") {
      setInfo({ status: "saving", nextAttemptAt: null });
      inflight = (async () => {
        let ok = false;
        let error: unknown = null;
        try {
          const text = serialize(getSnapshot());
          await storage.set(key, text);
          const meta: RecoveryMeta = {
            dirty: true,
            revision: action.revision,
            time: wallClock(),
            name: docName(),
          };
          await storage.set(metaKey, JSON.stringify(meta));
          ok = true;
        } catch (e) {
          error = e;
        }
        const t = now();
        policy.written(action.revision, ok, t);
        inflight = null;
        if (ok) {
          if (observedRevision === action.revision) pendingSince = null;
          setInfo({ status: "saved", error: null, lastSavedAt: t });
        } else {
          setInfo({ status: "error", error });
        }
        tick();
      })();
    } else if (action.type === "writeClean") {
      setInfo({ status: "saving", nextAttemptAt: null });
      inflight = (async () => {
        let ok = false;
        let error: unknown = null;
        try {
          await storage.set(metaKey, JSON.stringify({ dirty: false } satisfies RecoveryMeta));
          ok = true;
        } catch (e) {
          error = e;
        }
        policy.cleaned(ok, now());
        inflight = null;
        if (ok) {
          // Best effort: the clean meta already retired the snapshot.
          if (!policy.ownsSnapshot) await storage.remove(key).catch(() => undefined);
          setInfo({ status: "saved", error: null });
        } else {
          setInfo({ status: "error", error });
        }
        tick();
      })();
    } else if (action.type === "wakeAfter") {
      schedule(action.delay);
      setInfo(
        info.status === "error"
          ? { nextAttemptAt: now() + action.delay }
          : { status: rev !== savedRevision() ? "dirty" : info.status, nextAttemptAt: now() + action.delay },
      );
    } else if (rev === savedRevision() && info.status === "dirty") {
      setInfo({ status: policy.ownsSnapshot ? "dirty" : "idle", nextAttemptAt: null });
    } else if (rev !== savedRevision() && info.status !== "saved" && info.status !== "error") {
      setInfo({ status: "dirty" });
    }
  };

  function tick(): void {
    if (destroyed || inflight) return;
    const t = now();
    const rev = observe(t);
    const saved = savedRevision();
    if (!hydrated) {
      if (rev !== saved) setInfo({ status: "dirty" });
      return;
    }
    const force = forceNext;
    forceNext = false;
    if (rev !== saved && !force && info.status !== "error") {
      const changed = lastChangeAt ?? t;
      const due = Math.min(changed + debounceMs, (pendingSince ?? changed) + interval);
      if (t < due) {
        setInfo({ status: "dirty", nextAttemptAt: due });
        schedule(due - t);
        return;
      }
    }
    run(policy.tick(t, rev, saved, { force }), rev);
  }

  const whenIdle = async () => {
    while (inflight) await inflight;
  };

  return {
    getStatus: () => info,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      if (destroyed) return;
      const t = now();
      const before = observedRevision;
      const rev = observe(t);
      const dirty = rev !== savedRevision();
      if (dirty && rev !== before && info.status !== "error" && !inflight) {
        setInfo({ status: "dirty" });
      }
      if (!hydrated) return;
      // Never synchronous: listeners that update `savedRevision` may run after us.
      const changed = lastChangeAt ?? t;
      const due = Math.min(changed + debounceMs, (pendingSince ?? changed) + interval);
      schedule(dirty ? due - t : 0);
    },
    ready() {
      if (hydrated || destroyed) return;
      hydrated = true;
      setInfo({});
      schedule(0);
    },
    get isReady() {
      return hydrated;
    },
    async flushNow() {
      if (destroyed || !hydrated) return;
      await whenIdle();
      cancelTimer();
      forceNext = true;
      tick();
      await whenIdle();
    },
    async markClean() {
      if (destroyed) return;
      await whenIdle();
      cancelTimer();
      tick();
      await whenIdle();
    },
    async checkRecovery() {
      if (policy.ownsSnapshot) return null;
      let meta: RecoveryMeta;
      try {
        const metaText = await storage.get(metaKey);
        if (!metaText) return null;
        meta = JSON.parse(metaText) as RecoveryMeta;
      } catch {
        return null;
      }
      if (!meta || meta.dirty !== true) return null;
      const text = await storage.get(key).catch(() => null);
      if (text === null) return null;
      try {
        return { snapshot: deserialize(text), text, meta: meta as RecoveryMeta & { dirty: true } };
      } catch (error) {
        return { snapshot: undefined, text, meta: meta as RecoveryMeta & { dirty: true }, error };
      }
    },
    async discardRecovery() {
      if (policy.ownsSnapshot) return false;
      await whenIdle();
      await storage.remove(metaKey);
      await storage.remove(key);
      return true;
    },
    tick,
    whenIdle,
    destroy() {
      destroyed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
