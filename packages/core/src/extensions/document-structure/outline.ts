import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import {
  arraysEqual,
  generateStructureId,
  scrollDomAtPos,
  STRUCTURE_PRIORITY,
  syncInitialContent,
} from "./utils";

/**
 * A heading in the document outline, in document order.
 */
export interface OutlineHeading {
  /** Stable id stored on the heading node (`id` attribute). */
  id: string;
  /** Heading level (1-6). */
  level: number;
  /** Plain text of the heading. */
  text: string;
  /** Position of the heading node in the current document. */
  pos: number;
  /** Index of the heading in the outline. */
  index: number;
  /**
   * Nesting depth (0-based) relative to the enclosing headings, so skipped
   * levels (an h1 followed directly by an h3) only indent one step.
   */
  depth: number;
}

/**
 * A heading with its nested sub-headings.
 */
export interface OutlineTreeItem extends OutlineHeading {
  children: OutlineTreeItem[];
}

export interface OutlineOptions {
  /** Node types treated as headings. Defaults to `["heading"]`. */
  types: string[];
  /** Generates ids for headings that have none. */
  generateId: () => string;
  /** Called with the new outline whenever it changes. */
  onUpdate?: (headings: OutlineHeading[]) => void;
}

export interface OutlineStorage {
  /** The latest outline. Prefer `getOutline(editor)` for a fresh read. */
  headings: OutlineHeading[];
}

export interface FocusHeadingOptions {
  /** Scroll behaviour for the heading's DOM node. Defaults to `"smooth"`. */
  behavior?: ScrollBehavior;
  /** Whether to focus the editor and place the caret in the heading. Defaults to `true`. */
  focus?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    outline: {
      /** Places the caret at the start of a heading, focuses and scrolls to it. */
      focusHeading: (id: string, options?: FocusHeadingOptions) => ReturnType;
      /** Scrolls a heading into view without moving the selection. */
      scrollToHeading: (
        id: string,
        options?: Omit<FocusHeadingOptions, "focus">,
      ) => ReturnType;
    };
  }
}

export const outlinePluginKey = new PluginKey<OutlineHeading[]>("outline");
const outlineIdPluginKey = new PluginKey("outlineIds");

const sameHeading = (a: OutlineHeading, b: OutlineHeading) =>
  a.id === b.id &&
  a.level === b.level &&
  a.text === b.text &&
  a.pos === b.pos &&
  a.depth === b.depth;

/**
 * Derives the heading outline from a document. Only block nodes are visited
 * (headings cannot nest inside text), so the cost is proportional to the number
 * of blocks, not characters.
 */
export function computeOutline(
  doc: ProsemirrorNode,
  types: readonly string[] = ["heading"],
): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const stack: number[] = [];
  doc.descendants((node, pos) => {
    if (types.includes(node.type.name)) {
      const level = Number(node.attrs.level) || 1;
      while (stack.length && stack[stack.length - 1] >= level) stack.pop();
      headings.push({
        id: node.attrs.id ?? `outline-${headings.length}`,
        level,
        text: node.textContent,
        pos,
        index: headings.length,
        depth: stack.length,
      });
      stack.push(level);
      return false;
    }
    // Text blocks never contain headings.
    return !node.isTextblock;
  });
  return headings;
}

/**
 * Nests a flat outline into a tree by heading level.
 */
export function buildOutlineTree(
  headings: readonly OutlineHeading[],
): OutlineTreeItem[] {
  const root: OutlineTreeItem[] = [];
  const stack: OutlineTreeItem[] = [];
  for (const heading of headings) {
    const item: OutlineTreeItem = { ...heading, children: [] };
    while (stack.length && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    if (stack.length) stack[stack.length - 1].children.push(item);
    else root.push(item);
    stack.push(item);
  }
  return root;
}

/**
 * Returns the outline of an editor state. Uses the Outline plugin's cached
 * outline when the extension is installed, otherwise computes it.
 */
export function getOutline(
  editorOrState: Editor | EditorState,
): OutlineHeading[] {
  const state: EditorState =
    "state" in editorOrState ? editorOrState.state : editorOrState;
  return outlinePluginKey.getState(state) ?? computeOutline(state.doc);
}

/**
 * Returns the heading whose section contains the selection head: the last
 * heading starting at or before it.
 */
export function getActiveHeading(
  editorOrState: Editor | EditorState,
  headings: readonly OutlineHeading[] = getOutline(editorOrState),
): OutlineHeading | null {
  const state: EditorState =
    "state" in editorOrState ? editorOrState.state : editorOrState;
  const head = state.selection.from;
  let lo = 0;
  let hi = headings.length - 1;
  let found: OutlineHeading | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].pos <= head) {
      found = headings[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Finds a heading in the current outline by id.
 */
function findHeading(state: EditorState, id: string) {
  return getOutline(state).find((h) => h.id === id) ?? null;
}

/**
 * Snapshot of the outline for UI bindings. Snapshots are immutable and only
 * replaced when the outline or the active heading changes, so they can be used
 * directly with `useSyncExternalStore` or Svelte state.
 */
export interface OutlineSnapshot {
  headings: OutlineHeading[];
  tree: OutlineTreeItem[];
  activeId: string | null;
}

const EMPTY_SNAPSHOT: OutlineSnapshot = Object.freeze({
  headings: [],
  tree: [],
  activeId: null,
}) as OutlineSnapshot;

export interface OutlineStore {
  getSnapshot: () => OutlineSnapshot;
  subscribe: (listener: () => void) => () => void;
  destroy: () => void;
}

/**
 * Creates an observable outline store for an editor, shared by the React and
 * Svelte outline panels.
 */
export function createOutlineStore(editor: Editor | null | undefined): OutlineStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;

  const compute = () => {
    if (!editor || editor.isDestroyed) return EMPTY_SNAPSHOT;
    const headings = getOutline(editor);
    const activeId = getActiveHeading(editor, headings)?.id ?? null;
    const sameStructure = arraysEqual(snapshot.headings, headings, sameHeading);
    if (sameStructure && snapshot.activeId === activeId) return snapshot;
    return {
      headings: sameStructure ? snapshot.headings : headings,
      tree: sameStructure ? snapshot.tree : buildOutlineTree(headings),
      activeId,
    };
  };

  snapshot = compute();

  const onTransaction = () => {
    const next = compute();
    if (next !== snapshot) {
      snapshot = next;
      listeners.forEach((l) => l());
    }
  };

  // The editor listener is only attached while someone is subscribed, so a
  // store that is created but never subscribed (e.g. a discarded React render)
  // does not leak.
  return {
    getSnapshot: () => {
      if (!listeners.size) snapshot = compute();
      return snapshot;
    },
    subscribe(listener) {
      if (!listeners.size) {
        snapshot = compute();
        editor?.on("transaction", onTransaction);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) editor?.off("transaction", onTransaction);
      };
    },
    destroy() {
      editor?.off("transaction", onTransaction);
      listeners.clear();
    },
  };
}

/**
 * Moves the caret to the start of a heading, focuses the editor and scrolls the
 * heading into view. Works with or without the Outline extension installed.
 */
export function navigateToHeading(
  editor: Editor,
  heading: Pick<OutlineHeading, "id" | "pos">,
  options: FocusHeadingOptions = {},
): boolean {
  if (!editor || editor.isDestroyed) return false;
  const current =
    findHeading(editor.state, heading.id) ??
    getOutline(editor).find((h) => h.pos === heading.pos);
  if (!current) return false;
  const { focus = true, behavior = "smooth" } = options;
  if (focus) {
    const tr = editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, current.pos + 1))
      .scrollIntoView();
    editor.view.dispatch(tr);
    editor.view.focus();
  }
  scrollDomAtPos(editor.view, current.pos, behavior);
  return true;
}

/**
 * Assigns ids to headings that have none, and re-ids duplicates (created by
 * splitting a heading or pasting a copy of one).
 */
function assignHeadingIds(
  state: EditorState,
  types: readonly string[],
  generateId: () => string,
): Transaction | null {
  const seen = new Set<string>();
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (types.includes(node.type.name)) {
      let id = node.attrs.id as string | null;
      if (!id || seen.has(id)) {
        do {
          id = generateId();
        } while (seen.has(id));
        tr = tr ?? state.tr;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
      }
      seen.add(id);
      return false;
    }
    return !node.isTextblock;
  });
  return tr;
}

/**
 * Headless document outline. Gives every heading a stable `id` attribute
 * (rendered as the HTML `id`, so `#id` links work in exported HTML) and keeps
 * an up-to-date outline in plugin state. Read it with `getOutline(editor)` or
 * observe it with `createOutlineStore(editor)`.
 */
export const Outline = Extension.create<OutlineOptions, OutlineStorage>({
  name: "outline",
  priority: STRUCTURE_PRIORITY,

  addOptions() {
    return {
      types: ["heading"],
      generateId: () => generateStructureId("h"),
      onUpdate: undefined,
    };
  },

  addStorage() {
    return { headings: [] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          id: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("id") || element.getAttribute("data-id"),
            renderHTML: (attributes: Record<string, any>) =>
              attributes.id ? { id: attributes.id } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      focusHeading:
        (id, options = {}) =>
        ({ state, tr, dispatch, view }) => {
          const heading = findHeading(state, id);
          if (!heading) return false;
          if (dispatch) {
            if (options.focus !== false) {
              tr.setSelection(TextSelection.create(tr.doc, heading.pos + 1));
              tr.scrollIntoView();
              view?.focus?.();
            }
            scrollDomAtPos(view, heading.pos, options.behavior);
          }
          return true;
        },
      scrollToHeading:
        (id, options = {}) =>
        ({ state, dispatch, view }) => {
          const heading = findHeading(state, id);
          if (!heading) return false;
          if (dispatch) scrollDomAtPos(view, heading.pos, options.behavior);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { types, generateId } = this.options;
    const storage = this.storage;
    const onUpdate = () => this.options.onUpdate;

    return [
      new Plugin<OutlineHeading[]>({
        key: outlinePluginKey,
        state: {
          init: (_config, state) => {
            const headings = computeOutline(state.doc, types);
            storage.headings = headings;
            return headings;
          },
          apply: (tr, prev, _oldState, newState) => {
            if (!tr.docChanged) return prev;
            const next = computeOutline(newState.doc, types);
            if (arraysEqual(prev, next, sameHeading)) return prev;
            storage.headings = next;
            onUpdate()?.(next);
            return next;
          },
        },
      }),
      new Plugin({
        key: outlineIdPluginKey,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return assignHeadingIds(newState, types, generateId);
        },
      }),
    ];
  },

  onBeforeCreate() {
    const { types, generateId } = this.options;
    syncInitialContent(this.editor, (state) => assignHeadingIds(state, types, generateId));
  },
});
