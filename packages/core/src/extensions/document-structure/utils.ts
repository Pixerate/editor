import { createDocument, type Editor } from "@tiptap/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";

let idCounter = 0;

/**
 * Generates a short, document-unique-enough id (`prefix-xxxxxxxx`). Ids are
 * stored in the document, so they must not depend on positions or text.
 */
export function generateStructureId(prefix: string): string {
  idCounter = (idCounter + 1) % 1296;
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${prefix}-${random}${idCounter.toString(36).padStart(2, "0")}`;
}

/**
 * Returns true if any transaction inserted content containing one of the given
 * node or mark type names. Used to skip whole-document scans for transactions
 * that cannot have introduced the nodes a plugin tracks.
 */
export function transactionsInsert(
  transactions: readonly Transaction[],
  typeNames: readonly string[],
): boolean {
  for (const tr of transactions) {
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) {
        // Mark and attribute steps can add bookmarks or retarget nodes.
        const mark = (step as any).mark;
        if (mark && typeNames.includes(mark.type.name)) return true;
        continue;
      }
      let found = false;
      step.slice.content.descendants((node) => {
        if (found) return false;
        if (
          typeNames.includes(node.type.name) ||
          node.marks.some((m) => typeNames.includes(m.type.name))
        ) {
          found = true;
        }
        return !found;
      });
      if (found) return true;
    }
  }
  return false;
}

/**
 * Returns true if the document contains a node (or mark) of one of the types.
 */
export function docContains(
  doc: ProsemirrorNode,
  typeNames: readonly string[],
): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (
      typeNames.includes(node.type.name) ||
      node.marks.some((m) => typeNames.includes(m.type.name))
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

/**
 * Plugin state spec that tracks whether the document contains any of the given
 * node or mark types. A document without them is only rescanned when a
 * transaction inserts one, so plugins can skip their sync pass cheaply.
 */
export function presenceStateSpec(typeNames: readonly string[]) {
  return {
    init: (_config: unknown, state: EditorState) =>
      docContains(state.doc, typeNames),
    apply: (
      tr: Transaction,
      present: boolean,
      _oldState: EditorState,
      newState: EditorState,
    ) => {
      if (!tr.docChanged) return present;
      if (!present && !transactionsInsert([tr], typeNames)) return false;
      return docContains(newState.doc, typeNames);
    },
  };
}

/**
 * Shallow array equality using a per-item comparator.
 */
export function arraysEqual<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Scrolls the DOM node at a document position into view, if the editor is
 * mounted in a browser. Errors from detached or headless views are ignored.
 */
export function scrollDomAtPos(
  view: any,
  pos: number,
  behavior: ScrollBehavior = "smooth",
): void {
  try {
    const dom = view?.nodeDOM?.(pos) as HTMLElement | null;
    if (dom && typeof dom.scrollIntoView === "function") {
      dom.scrollIntoView({ block: "start", behavior });
    }
  } catch {
    // Headless editors (no DOM) cannot scroll.
  }
}

/**
 * Applies a sync pass to the editor's initial content. `appendTransaction`
 * does not run for the initial document and TipTap's `create` event fires
 * asynchronously, so derived state (heading ids, TOC entries, footnote
 * numbers) is computed in `onBeforeCreate` instead: the content is parsed,
 * fixed, and handed back to TipTap as a node. Extensions calling this must
 * have a priority below the Markdown extension's (50), so that markdown
 * content has already been converted to HTML.
 */
export function syncInitialContent(
  editor: Editor,
  sync: (state: EditorState) => Transaction | null,
): void {
  const { content } = editor.options;
  if (content == null || content === "") return;
  try {
    const doc = createDocument(content as any, editor.schema, editor.options.parseOptions, {
      errorOnInvalidContent: false,
    });
    const tr = sync(EditorState.create({ doc }));
    if (tr?.docChanged) editor.options.content = tr.doc as any;
  } catch {
    // Leave invalid content to TipTap's own handling.
  }
}

/** Priority for extensions that use `syncInitialContent` (below Markdown's 50). */
export const STRUCTURE_PRIORITY = 45;
