import { useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  createParagraphStylesStore,
  getStyleRegistry,
  type CreateStyleFromSelectionOptions,
  type ParagraphStylesSnapshot,
  type StyleDefinition,
  type StyleRegistry,
} from "@pixerate/editor";

export type { ParagraphStylesSnapshot, StyleDefinition } from "@pixerate/editor";

export interface UseParagraphStylesResult extends ParagraphStylesSnapshot {
  registry: StyleRegistry | null;
  /** The style of the block at the selection. */
  currentStyle: StyleDefinition | null;
  /** Applies a paragraph style to the selected blocks. */
  apply: (id: string) => boolean;
  /** Resets the selected blocks to Normal. */
  clear: () => boolean;
  /** Updates a style (default: the current one) to the formatting at the selection. */
  updateFromSelection: (id?: string) => boolean;
  /** Creates (and applies) a style from the formatting at the selection; returns its id. */
  createFromSelection: (name: string, options?: CreateStyleFromSelectionOptions) => string | null;
  /** Applies a character style to the selection. */
  applyCharacterStyle: (id: string) => boolean;
}

/**
 * Subscribes to an editor's paragraph styles (`ParagraphStyles` extension):
 * the gallery, all styles and the style at the selection, with commands.
 * Re-renders only when the styles or the current style change.
 */
export function useParagraphStyles(editor: Editor | null | undefined): UseParagraphStylesResult {
  // The store only listens to the editor while subscribed (StrictMode-safe).
  const store = useMemo(() => createParagraphStylesStore(editor), [editor]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return useMemo(() => {
    const registry = getStyleRegistry(editor);
    const live = () => (editor && !editor.isDestroyed ? editor : null);
    return {
      ...snapshot,
      registry,
      currentStyle: (snapshot.currentStyleId && registry?.get(snapshot.currentStyleId)) || null,
      apply: (id) => !!live()?.chain().focus().setParagraphStyle(id).run(),
      clear: () => !!live()?.chain().focus().clearParagraphStyle().run(),
      updateFromSelection: (id) => !!live()?.chain().focus().updateParagraphStyleFromSelection(id).run(),
      createFromSelection: (name, options) => {
        const e = live();
        if (!e || !registry) return null;
        const id = options?.id ?? registry.newId(name.trim());
        const ok = e.chain().focus().createParagraphStyleFromSelection(name, { ...options, id }).run();
        return ok ? id : null;
      },
      applyCharacterStyle: (id) => !!live()?.chain().focus().setCharacterStyle(id).run(),
    };
  }, [snapshot, editor]);
}
