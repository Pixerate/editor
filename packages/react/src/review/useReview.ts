import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  getCommentStore,
  getTrackChangesStore,
  type CommentStore,
  type CommentStoreSnapshot,
  type TrackChangesSnapshot,
  type TrackedChange,
} from "@pixerate/editor";

const EMPTY_COMMENTS: CommentStoreSnapshot = Object.freeze({
  threads: [],
  activeThreadId: null,
}) as CommentStoreSnapshot;

const EMPTY_TRACK_CHANGES: TrackChangesSnapshot = Object.freeze({
  enabled: false,
  author: { id: "anonymous", name: "Anonymous" },
  changes: [],
  currentChangeId: null,
}) as TrackChangesSnapshot;

const noopUnsubscribe = () => {};

function isCommentStore(value: unknown): value is CommentStore {
  return (
    !!value &&
    typeof (value as CommentStore).getSnapshot === "function" &&
    typeof (value as CommentStore).createThread === "function"
  );
}

export interface UseCommentsResult extends CommentStoreSnapshot {
  store: CommentStore | null;
}

/**
 * Subscribes to a comment store: pass the store itself, or an editor using
 * the `Comments` extension (`null` while the editor is being created).
 */
export function useComments(
  source: Editor | CommentStore | null | undefined,
): UseCommentsResult {
  const store = isCommentStore(source) ? source : getCommentStore(source as Editor | null);
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(() => onChange()) : noopUnsubscribe),
    [store],
  );
  const getSnapshot = () => store?.getSnapshot() ?? EMPTY_COMMENTS;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => ({ ...snapshot, store }), [snapshot, store]);
}

export interface UseTrackChangesResult extends TrackChangesSnapshot {
  currentChange: TrackedChange | null;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  accept: (id: string) => void;
  reject: (id: string) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  next: () => void;
  previous: () => void;
  /** Selects a change in the editor. */
  select: (id: string) => void;
  /** Accepts a tracked move (both ends). */
  acceptMove: (id: string) => void;
  /** Rejects a tracked move (both ends). */
  rejectMove: (id: string) => void;
}

/**
 * Subscribes to the tracked-change state of an editor using the
 * `TrackChanges` extension and exposes its commands.
 */
export function useTrackChanges(editor: Editor | null | undefined): UseTrackChangesResult {
  const store = getTrackChangesStore(editor ?? null);
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(() => onChange()) : noopUnsubscribe),
    [store],
  );
  const getSnapshot = () => store?.getSnapshot() ?? EMPTY_TRACK_CHANGES;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    const run = (fn: (e: Editor) => void) => () => {
      if (editor && !editor.isDestroyed) fn(editor);
    };
    return {
      ...snapshot,
      currentChange:
        snapshot.changes.find((c) => c.id === snapshot.currentChangeId) ?? null,
      setEnabled: (enabled: boolean) => run((e) => e.commands.setTrackChanges(enabled))(),
      toggle: run((e) => e.commands.toggleTrackChanges()),
      accept: (id: string) => run((e) => e.commands.acceptChange(id))(),
      reject: (id: string) => run((e) => e.commands.rejectChange(id))(),
      acceptAll: run((e) => e.commands.acceptAllChanges()),
      rejectAll: run((e) => e.commands.rejectAllChanges()),
      next: run((e) => e.chain().focus().selectNextChange().run()),
      previous: run((e) => e.chain().focus().selectPreviousChange().run()),
      select: (id: string) => run((e) => e.chain().focus().selectChange(id).run())(),
      acceptMove: (id: string) => run((e) => e.commands.acceptMove(id))(),
      rejectMove: (id: string) => run((e) => e.commands.rejectMove(id))(),
    };
  }, [snapshot, editor]);
}
