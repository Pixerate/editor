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

export interface SvelteParagraphStyles {
  /** Snapshot: gallery, styles, character styles, current style id, version. */
  readonly current: ParagraphStylesSnapshot;
  readonly registry: StyleRegistry | null;
  /** The style of the block at the selection. */
  readonly currentStyle: StyleDefinition | null;
  /** Applies a paragraph style to the selected blocks. */
  apply(id: string): boolean;
  /** Resets the selected blocks to Normal. */
  clear(): boolean;
  /** Updates a style (default: the current one) to the formatting at the selection. */
  updateFromSelection(id?: string): boolean;
  /** Creates (and applies) a style from the formatting at the selection; returns its id. */
  createFromSelection(name: string, options?: CreateStyleFromSelectionOptions): string | null;
  /** Applies a character style to the selection. */
  applyCharacterStyle(id: string): boolean;
  destroy(): void;
}

/**
 * Reactive paragraph styles for Svelte 5 (the counterpart of React's
 * `useParagraphStyles`): the gallery, all styles and the style at the
 * selection, with commands. `current` is replaced only when the styles or
 * the current style change. Call `destroy()` when done (or create it inside
 * a component's `$effect`).
 */
export function createParagraphStyles(editor: Editor | null | undefined): SvelteParagraphStyles {
  const store = createParagraphStylesStore(editor);
  const registry = getStyleRegistry(editor);
  let current = $state.raw<ParagraphStylesSnapshot>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    current = store.getSnapshot();
  });
  const live = () => (editor && !editor.isDestroyed ? editor : null);

  return {
    get current() {
      return current;
    },
    get registry() {
      return registry;
    },
    get currentStyle() {
      return (current.currentStyleId && registry?.get(current.currentStyleId)) || null;
    },
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
    destroy() {
      unsubscribe();
      store.destroy();
    },
  };
}
