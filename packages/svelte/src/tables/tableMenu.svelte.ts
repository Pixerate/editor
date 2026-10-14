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

export interface SvelteTableMenu {
  /** The table state at the selection (replaced only when it changes). */
  readonly current: TableState;
  /** Runs a table action (focusing the editor); `false` when it cannot run. */
  run(action: TableAction, params?: TableActionParams): boolean;
  /** `true`, or why the action cannot run with these params. */
  check(action: TableAction, params?: TableActionParams): true | string;
  destroy(): void;
}

/**
 * Reactive table state for Svelte 5 (the counterpart of React's
 * `useTableMenu`): whether the selection is in a table, its size, header
 * state, cell alignment/background and the enablement (with reasons) of every
 * table action. Call `destroy()` when done (or create it inside a
 * component's `$effect`).
 */
export function createTableMenu(editor: Editor | null | undefined): SvelteTableMenu {
  const store = createTableStore(editor);
  let current = $state.raw<TableState>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    current = store.getSnapshot();
  });
  current = store.getSnapshot();

  return {
    get current() {
      return current;
    },
    run: (action, params) => runTableAction(editor, action, params, { focus: true }),
    check: (action, params) => getTableActionState(editor, action, params),
    destroy() {
      unsubscribe();
      store.destroy();
    },
  };
}
