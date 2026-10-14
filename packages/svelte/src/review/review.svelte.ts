import type { Editor } from "@tiptap/core";
import {
  getCommentStore,
  getTrackChangesStore,
  type CommentStore,
  type CommentStoreSnapshot,
  type CommentThread,
  type TrackChangesSnapshot,
  type TrackedChange,
} from "@pixerate/editor";

export const EMPTY_COMMENTS_SNAPSHOT: CommentStoreSnapshot = Object.freeze({
  threads: [],
  activeThreadId: null,
}) as CommentStoreSnapshot;

export const EMPTY_TRACK_CHANGES_SNAPSHOT: TrackChangesSnapshot = Object.freeze({
  enabled: false,
  author: { id: "anonymous", name: "Anonymous" },
  changes: [],
  currentChangeId: null,
}) as TrackChangesSnapshot;

export function isCommentStore(value: unknown): value is CommentStore {
  return (
    !!value &&
    typeof (value as CommentStore).getSnapshot === "function" &&
    typeof (value as CommentStore).createThread === "function"
  );
}

/** Resolves a comment store from a store or an editor using `Comments`. */
export function resolveCommentStore(
  source: Editor | CommentStore | null | undefined,
): CommentStore | null {
  return isCommentStore(source) ? source : getCommentStore(source as Editor | null);
}

export interface SvelteComments {
  readonly threads: readonly CommentThread[];
  readonly activeThreadId: string | null;
  readonly store: CommentStore | null;
  subscribe(run: (value: CommentStoreSnapshot) => void): () => void;
  destroy(): void;
}

/**
 * Reactive (runes) and Svelte-store-compatible view of a comment store. Pass
 * the store or an editor using the `Comments` extension. Call `destroy()`
 * when done (or create it inside a component, where it lives as long as the
 * component).
 */
export function createComments(source: Editor | CommentStore | null | undefined): SvelteComments {
  const store = resolveCommentStore(source);
  let snapshot = $state.raw<CommentStoreSnapshot>(store?.getSnapshot() ?? EMPTY_COMMENTS_SNAPSHOT);
  const unsubscribe = store
    ? store.subscribe((value) => {
        snapshot = value;
      })
    : () => {};

  return {
    get threads() {
      return snapshot.threads;
    },
    get activeThreadId() {
      return snapshot.activeThreadId;
    },
    get store() {
      return store;
    },
    subscribe(run) {
      if (!store) {
        run(EMPTY_COMMENTS_SNAPSHOT);
        return () => {};
      }
      return store.subscribe(run);
    },
    destroy: unsubscribe,
  };
}

export interface SvelteTrackChanges extends TrackChangesSnapshot {
  readonly currentChange: TrackedChange | null;
  setEnabled(enabled: boolean): void;
  toggle(): void;
  accept(id: string): void;
  reject(id: string): void;
  acceptAll(): void;
  rejectAll(): void;
  next(): void;
  previous(): void;
  /** Selects a change in the editor. */
  select(id: string): void;
  /** Accepts a tracked move (both ends). */
  acceptMove(id: string): void;
  /** Rejects a tracked move (both ends). */
  rejectMove(id: string): void;
  subscribe(run: (value: TrackChangesSnapshot) => void): () => void;
  destroy(): void;
}

/**
 * Reactive (runes) and Svelte-store-compatible view of an editor's tracked
 * changes (`TrackChanges` extension) with its commands.
 */
export function createTrackChanges(editor: Editor | null | undefined): SvelteTrackChanges {
  const store = getTrackChangesStore(editor ?? null);
  let snapshot = $state.raw<TrackChangesSnapshot>(
    store?.getSnapshot() ?? EMPTY_TRACK_CHANGES_SNAPSHOT,
  );
  const unsubscribe = store
    ? store.subscribe((value) => {
        snapshot = value;
      })
    : () => {};
  const run = (fn: (e: Editor) => void) => {
    if (editor && !editor.isDestroyed) fn(editor);
  };

  return {
    get enabled() {
      return snapshot.enabled;
    },
    get author() {
      return snapshot.author;
    },
    get changes() {
      return snapshot.changes;
    },
    get currentChangeId() {
      return snapshot.currentChangeId;
    },
    get currentChange() {
      return snapshot.changes.find((c) => c.id === snapshot.currentChangeId) ?? null;
    },
    setEnabled: (enabled) => run((e) => e.commands.setTrackChanges(enabled)),
    toggle: () => run((e) => e.commands.toggleTrackChanges()),
    accept: (id) => run((e) => e.commands.acceptChange(id)),
    reject: (id) => run((e) => e.commands.rejectChange(id)),
    acceptAll: () => run((e) => e.commands.acceptAllChanges()),
    rejectAll: () => run((e) => e.commands.rejectAllChanges()),
    next: () => run((e) => e.chain().focus().selectNextChange().run()),
    previous: () => run((e) => e.chain().focus().selectPreviousChange().run()),
    select: (id) => run((e) => e.chain().focus().selectChange(id).run()),
    acceptMove: (id) => run((e) => e.commands.acceptMove(id)),
    rejectMove: (id) => run((e) => e.commands.rejectMove(id)),
    subscribe(runFn) {
      if (!store) {
        runFn(EMPTY_TRACK_CHANGES_SNAPSHOT);
        return () => {};
      }
      return store.subscribe(runFn);
    },
    destroy: unsubscribe,
  };
}
