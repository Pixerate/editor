import { useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { createOutlineStore, type OutlineSnapshot } from "@pixerate/editor";

export type { OutlineHeading, OutlineSnapshot, OutlineTreeItem } from "@pixerate/editor";

/**
 * Subscribes to an editor's heading outline. Returns the headings (flat and
 * nested) and the id of the heading whose section contains the selection.
 * Re-renders only when the outline or the active heading changes.
 *
 * Install the `Outline` extension (`richTextOptions: { outline: true }`) for
 * stable heading ids; without it, headings are still listed.
 */
export function useOutline(editor: Editor | null | undefined): OutlineSnapshot {
  // The store only listens to the editor while subscribed, so it needs no
  // explicit cleanup (and survives StrictMode's double effects).
  const store = useMemo(() => createOutlineStore(editor), [editor]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
