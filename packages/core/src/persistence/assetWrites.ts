/**
 * Coordination between asset writes and asset garbage collection (internal: not exported from
 * the package). Collection must never delete an asset that a write in flight is about to point a
 * document at, so:
 *
 * - every write that persists assets leases their references until its document is written, and
 *   a running collection skips leased references and references leased while it runs;
 * - where the Web Locks API exists, writes hold a shared lock and collection an exclusive one,
 *   which extends the same guarantee to other tabs on the same origin.
 */

const leases = new Map<string, number>();
const watchers = new Set<Set<string>>();

/** Marks `refs` as about to be referenced by a document write; call the result when it is written. */
export function leaseAssetRefs(refs: Iterable<string>): () => void {
  const held = [...new Set(refs)];
  for (const ref of held) {
    leases.set(ref, (leases.get(ref) ?? 0) + 1);
    for (const touched of watchers) touched.add(ref);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const ref of held) {
      const n = (leases.get(ref) ?? 1) - 1;
      if (n > 0) leases.set(ref, n);
      else leases.delete(ref);
    }
  };
}

/**
 * Starts recording references that are, or become, leased. `touched` holds every reference
 * leased now or at any time until `stop()`.
 */
export function watchAssetLeases(): { touched: Set<string>; stop(): void } {
  const touched = new Set(leases.keys());
  watchers.add(touched);
  return { touched, stop: () => void watchers.delete(touched) };
}

interface LockManagerLike {
  request<T>(name: string, options: { mode: "shared" | "exclusive" }, callback: () => Promise<T>): Promise<T>;
}

/** Runs `task` under the cross-tab asset lock for `prefix` when the Web Locks API exists. */
export function withAssetLock<T>(prefix: string, mode: "shared" | "exclusive", task: () => Promise<T>): Promise<T> {
  let locks: LockManagerLike | undefined;
  try {
    locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  } catch {
    locks = undefined;
  }
  if (!locks || typeof locks.request !== "function") return task();
  return locks.request(`pixerate-editor-assets:${prefix}`, { mode }, task);
}
