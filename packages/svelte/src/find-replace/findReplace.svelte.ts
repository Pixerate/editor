import type { Editor } from "@tiptap/core";
import {
  EMPTY_FIND_REPLACE_SNAPSHOT,
  getFindReplaceStore,
  type FindOptions,
  type FindReplaceMode,
  type FindReplaceSnapshot,
} from "@pixerate/editor";

export interface SvelteFindReplace extends FindReplaceSnapshot {
  /** Whether the editor has the `FindReplace` extension. */
  readonly available: boolean;
  readonly matchCount: number;
  show(mode?: FindReplaceMode): void;
  close(): void;
  setQuery(query: string): void;
  setReplacement(replacement: string): void;
  setOptions(options: Partial<FindOptions>): void;
  toggleOption(option: keyof FindOptions): void;
  next(): void;
  previous(): void;
  replace(): void;
  replaceAll(): void;
  clear(): void;
  subscribe(run: (value: FindReplaceSnapshot) => void): () => void;
  destroy(): void;
}

/**
 * Reactive (runes) and Svelte-store-compatible view of an editor's Find and
 * Replace state (`FindReplace` extension) with its commands. Call
 * `destroy()` when done (or create it inside a component).
 */
export function createFindReplace(editor: Editor | null | undefined): SvelteFindReplace {
  const store = getFindReplaceStore(editor ?? null);
  let snapshot = $state.raw<FindReplaceSnapshot>(store?.getSnapshot() ?? EMPTY_FIND_REPLACE_SNAPSHOT);
  const unsubscribe = store
    ? store.subscribe((value) => {
        snapshot = value;
      })
    : () => {};
  const run = (fn: (e: Editor) => void) => {
    if (editor && !editor.isDestroyed && store) fn(editor);
  };

  return {
    get available() {
      return !!store;
    },
    get open() {
      return snapshot.open;
    },
    get mode() {
      return snapshot.mode;
    },
    get query() {
      return snapshot.query;
    },
    get replacement() {
      return snapshot.replacement;
    },
    get options() {
      return snapshot.options;
    },
    get matches() {
      return snapshot.matches;
    },
    get matchCount() {
      return snapshot.matches.length;
    },
    get currentIndex() {
      return snapshot.currentIndex;
    },
    get error() {
      return snapshot.error;
    },
    get truncated() {
      return snapshot.truncated;
    },
    get lastReplaceCount() {
      return snapshot.lastReplaceCount;
    },
    get focusRequest() {
      return snapshot.focusRequest;
    },
    show: (mode = "find") => run((e) => e.commands.openFindReplace({ mode })),
    close: () => run((e) => e.commands.closeFindReplace()),
    setQuery: (query) => run((e) => e.commands.setSearch({ query })),
    setReplacement: (replacement) => run((e) => e.commands.setSearch({ replacement })),
    setOptions: (options) => run((e) => e.commands.setSearch({ options })),
    toggleOption: (option) =>
      run((e) => e.commands.setSearch({ options: { [option]: !snapshot.options[option] } })),
    next: () => run((e) => e.commands.findNext()),
    previous: () => run((e) => e.commands.findPrevious()),
    replace: () => run((e) => e.commands.replaceCurrent()),
    replaceAll: () => run((e) => e.commands.replaceAll()),
    clear: () => run((e) => e.commands.clearSearch()),
    subscribe(runFn) {
      if (!store) {
        runFn(EMPTY_FIND_REPLACE_SNAPSHOT);
        return () => {};
      }
      return store.subscribe(runFn);
    },
    destroy: unsubscribe,
  };
}
