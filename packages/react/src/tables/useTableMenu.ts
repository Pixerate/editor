import { useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  createTableStore,
  getTableActionState,
  runTableAction,
  type TableAction,
  type TableActionParams,
  type TableState,
} from "@pixerate/editor";

export type { TableAction, TableActionParams, TableState } from "@pixerate/editor";

export interface UseTableMenuResult extends TableState {
  /** Runs a table action (focusing the editor); `false` when it cannot run. */
  run: (action: TableAction, params?: TableActionParams) => boolean;
  /** `true`, or why the action cannot run with these params. */
  check: (action: TableAction, params?: TableActionParams) => true | string;
}

/**
 * Subscribes to the table at the editor's selection: whether the selection
 * is in a table, its size, header state, the cell's alignment and
 * background, and the enablement (with reasons) of every table action.
 * Re-renders only when that state changes. The Svelte counterpart is
 * `createTableMenu`.
 */
export function useTableMenu(editor: Editor | null | undefined): UseTableMenuResult {
  // The store only listens to the editor while subscribed (StrictMode-safe).
  const store = useMemo(() => createTableStore(editor), [editor]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(
    () => ({
      ...snapshot,
      run: (action, params) => runTableAction(editor, action, params, { focus: true }),
      check: (action, params) => getTableActionState(editor, action, params),
    }),
    [snapshot, editor],
  );
}
