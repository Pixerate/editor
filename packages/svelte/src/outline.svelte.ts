import type { Editor } from "@tiptap/core";
import { createOutlineStore, type OutlineSnapshot } from "@pixerate/editor";

export type { OutlineHeading, OutlineSnapshot, OutlineTreeItem } from "@pixerate/editor";

/**
 * Reactive heading outline for Svelte 5 (the counterpart of React's
 * `useOutline`). `current` holds the headings (flat and nested) and the id of
 * the heading whose section contains the selection; it is replaced only when
 * those change. Call `destroy()` when done (or create it inside a component,
 * where it is cleaned up with the component's effects).
 *
 * Install the `Outline` extension (`richTextOptions: { outline: true }`) for
 * stable heading ids; without it, headings are still listed.
 */
export function createOutline(editor: Editor | null | undefined) {
  const store = createOutlineStore(editor);
  let current = $state.raw<OutlineSnapshot>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    current = store.getSnapshot();
  });

  return {
    get current() {
      return current;
    },
    destroy() {
      unsubscribe();
      store.destroy();
    },
  };
}
