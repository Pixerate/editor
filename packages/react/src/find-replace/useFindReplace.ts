import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  EMPTY_FIND_REPLACE_SNAPSHOT,
  getFindReplaceStore,
  type FindOptions,
  type FindReplaceMode,
  type FindReplaceSnapshot,
} from "@pixerate/editor";

export interface UseFindReplaceResult extends FindReplaceSnapshot {
  /** Whether the editor has the `FindReplace` extension. */
  available: boolean;
  matchCount: number;
  open: boolean;
  show: (mode?: FindReplaceMode) => void;
  close: () => void;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  setOptions: (options: Partial<FindOptions>) => void;
  toggleOption: (option: keyof FindOptions) => void;
  next: () => void;
  previous: () => void;
  replace: () => void;
  replaceAll: () => void;
  clear: () => void;
}

const noopUnsubscribe = () => {};

/**
 * Subscribes to an editor's Find and Replace state (`FindReplace` extension)
 * and exposes its commands.
 */
export function useFindReplace(editor: Editor | null | undefined): UseFindReplaceResult {
  const store = getFindReplaceStore(editor ?? null);
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(() => onChange()) : noopUnsubscribe),
    [store],
  );
  const getSnapshot = () => store?.getSnapshot() ?? EMPTY_FIND_REPLACE_SNAPSHOT;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    const run = (fn: (e: Editor) => void) => {
      if (editor && !editor.isDestroyed && store) fn(editor);
    };
    return {
      ...snapshot,
      available: !!store,
      matchCount: snapshot.matches.length,
      show: (mode: FindReplaceMode = "find") =>
        run((e) => e.commands.openFindReplace({ mode })),
      close: () => run((e) => e.commands.closeFindReplace()),
      setQuery: (query: string) => run((e) => e.commands.setSearch({ query })),
      setReplacement: (replacement: string) => run((e) => e.commands.setSearch({ replacement })),
      setOptions: (options: Partial<FindOptions>) => run((e) => e.commands.setSearch({ options })),
      toggleOption: (option: keyof FindOptions) =>
        run((e) => e.commands.setSearch({ options: { [option]: !snapshot.options[option] } })),
      next: () => run((e) => e.commands.findNext()),
      previous: () => run((e) => e.commands.findPrevious()),
      replace: () => run((e) => e.commands.replaceCurrent()),
      replaceAll: () => run((e) => e.commands.replaceAll()),
      clear: () => run((e) => e.commands.clearSearch()),
    };
  }, [snapshot, editor, store]);
}
