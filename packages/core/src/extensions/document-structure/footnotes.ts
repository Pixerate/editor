import { Node } from "@tiptap/core";
import { safeMergeAttributes } from "../safe-merge-attributes";
import type { Node as ProsemirrorNode, Schema } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { footnotesMarkdownIt, mergeFootnoteSections } from "./markdown-it";
import {
  generateStructureId,
  presenceStateSpec,
  scrollDomAtPos,
  STRUCTURE_PRIORITY,
  syncInitialContent,
} from "./utils";

/**
 * A footnote as listed by `getFootnotes`.
 */
export interface FootnoteInfo {
  id: string;
  /** 1-based number, in document order of the references. */
  number: number;
  /** Plain text of the footnote content (paragraphs joined by blank lines). */
  text: string;
  /** Position of the reference node. */
  referencePos: number;
  /** Position of the footnote node in the footnotes list, if present. */
  footnotePos: number | null;
}

export interface FootnotesOptions {
  HTMLAttributes: Record<string, any>;
  /** Generates ids for new footnotes. */
  generateId: () => string;
}

export interface InsertFootnoteOptions {
  /** Plain-text content. Blank lines separate paragraphs. */
  content?: string;
  /** Explicit id; generated when omitted. */
  id?: string;
  /**
   * Move the caret into the new footnote (Word's behaviour). Defaults to `true`
   * when no `content` is given.
   */
  focusContent?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnotes: {
      /** Inserts a footnote reference at the selection, plus its footnote. */
      insertFootnote: (options?: InsertFootnoteOptions) => ReturnType;
      /** Replaces a footnote's content with plain text. */
      updateFootnote: (id: string, content: string) => ReturnType;
      /** Removes a footnote and its reference. */
      deleteFootnote: (id: string) => ReturnType;
      /** Moves the caret into a footnote's content. */
      goToFootnote: (id: string) => ReturnType;
      /** Selects a footnote's reference in the body text. */
      goToFootnoteReference: (id: string) => ReturnType;
    };
  }
}

export const footnotesPluginKey = new PluginKey<boolean>("footnotes");

const REFERENCE = "footnoteReference";
const LIST = "footnotes";
const ITEM = "footnote";

function paragraphsFromText(schema: Schema, text: string): ProsemirrorNode[] {
  const parts = text.split(/\n\s*\n/);
  return parts.map((part) =>
    schema.nodes.paragraph.create(null, part ? schema.text(part) : undefined),
  );
}

function footnoteText(node: ProsemirrorNode): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(child.textContent));
  return parts.join("\n\n");
}

/**
 * Lists the footnotes of a document in reference order.
 */
export function getFootnotes(doc: ProsemirrorNode): FootnoteInfo[] {
  const footnotes = new Map<string, { node: ProsemirrorNode; pos: number }>();
  const refs: { id: string; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === LIST) {
      node.forEach((child, offset) => {
        if (child.type.name === ITEM && !footnotes.has(child.attrs.id)) {
          footnotes.set(child.attrs.id, { node: child, pos: pos + 1 + offset });
        }
      });
      return false;
    }
    if (node.type.name === REFERENCE) refs.push({ id: node.attrs.id, pos });
    return true;
  });
  return refs.map((ref, index) => {
    const footnote = footnotes.get(ref.id);
    return {
      id: ref.id,
      number: index + 1,
      text: footnote ? footnoteText(footnote.node) : "",
      referencePos: ref.pos,
      footnotePos: footnote?.pos ?? null,
    };
  });
}

/**
 * Brings the footnotes list in line with the references: one footnote per
 * reference, in reference order, numbered 1..n, in a single list that is the
 * last child of the document. Orphaned footnotes are dropped, missing ones are
 * created (empty, or with `contents[id]`), and duplicated references (from
 * copy/paste) get a new id with a copy of the original footnote.
 *
 * Returns true if the transaction was modified.
 */
export function syncFootnotes(
  tr: Transaction,
  options: {
    generateId?: () => string;
    contents?: Record<string, string>;
  } = {},
): boolean {
  const schema = tr.doc.type.schema;
  const listType = schema.nodes[LIST];
  const itemType = schema.nodes[ITEM];
  if (!listType || !itemType) return false;
  const generateId = options.generateId ?? (() => generateStructureId("fn"));

  const refs: { node: ProsemirrorNode; pos: number }[] = [];
  const lists: { node: ProsemirrorNode; pos: number }[] = [];
  const existing = new Map<string, ProsemirrorNode>();
  tr.doc.descendants((node, pos) => {
    if (node.type === listType) {
      lists.push({ node, pos });
      node.forEach((child) => {
        if (child.type === itemType && !existing.has(child.attrs.id)) {
          existing.set(child.attrs.id, child);
        }
      });
      return false;
    }
    if (node.type.name === REFERENCE) refs.push({ node, pos });
    return true;
  });

  // Desired state.
  const seen = new Set<string>();
  const desiredRefs: { pos: number; id: string; number: number; copyOf?: string }[] = [];
  refs.forEach((ref, index) => {
    let id: string = ref.node.attrs.id;
    let copyOf: string | undefined;
    if (!id || seen.has(id)) {
      copyOf = id || undefined;
      do {
        id = generateId();
      } while (seen.has(id) || existing.has(id));
    }
    seen.add(id);
    desiredRefs.push({ pos: ref.pos, id, number: index + 1, copyOf });
  });

  const desiredItems = desiredRefs.map(({ id, number, copyOf }) => {
    const source = existing.get(id) ?? (copyOf ? existing.get(copyOf) : undefined);
    const content =
      source?.content ??
      paragraphsFromText(schema, options.contents?.[id] ?? "");
    if (
      source &&
      source.attrs.id === id &&
      source.attrs.number === number
    ) {
      return source;
    }
    return itemType.create({ id, number }, content);
  });

  // Is the document already in sync?
  const refsInSync = desiredRefs.every(
    (d, i) =>
      refs[i].node.attrs.id === d.id && refs[i].node.attrs.number === d.number,
  );
  const lastChild = tr.doc.lastChild;
  const listInSync = desiredItems.length
    ? lists.length === 1 &&
      lastChild === lists[0].node &&
      lists[0].node.childCount === desiredItems.length &&
      desiredItems.every((item, i) => lists[0].node.child(i) === item)
    : lists.length === 0;
  if (refsInSync && listInSync) return false;

  // Attribute changes keep node sizes, so reference positions stay valid.
  desiredRefs.forEach((d, i) => {
    const node = refs[i].node;
    if (node.attrs.id !== d.id || node.attrs.number !== d.number) {
      tr.setNodeMarkup(d.pos, undefined, { ...node.attrs, id: d.id, number: d.number });
    }
  });

  if (!listInSync) {
    for (let i = lists.length - 1; i >= 0; i--) {
      tr.delete(lists[i].pos, lists[i].pos + lists[i].node.nodeSize);
    }
    if (desiredItems.length) {
      tr.insert(tr.doc.content.size, listType.create(null, desiredItems));
    }
  }
  return true;
}

function findFootnote(doc: ProsemirrorNode, id: string) {
  let found: { node: ProsemirrorNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === ITEM && node.attrs.id === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found as { node: ProsemirrorNode; pos: number } | null;
}

function findReferences(doc: ProsemirrorNode, id: string) {
  const refs: { node: ProsemirrorNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === LIST) return false;
    if (node.type.name === REFERENCE && node.attrs.id === id) refs.push({ node, pos });
    return true;
  });
  return refs;
}

/**
 * Inline footnote reference, auto-numbered in document order. Its content
 * lives in a `footnote` item of the `footnotes` list at the end of the
 * document, which is created, renumbered, reordered and pruned automatically.
 *
 * Markdown: serialized as `[^n]` with `[^n]: text` definitions, and parsed
 * back when the Markdown extension is installed.
 */
export const FootnoteReference = Node.create<FootnotesOptions>({
  name: REFERENCE,
  priority: STRUCTURE_PRIORITY - 5,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      generateId: () => generateStructureId("fn"),
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-id"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.id ? { "data-id": attributes.id } : {},
      },
      number: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute("data-number")) || null,
        renderHTML: (attributes: Record<string, any>) =>
          attributes.number ? { "data-number": attributes.number } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-type="footnote-reference"]', priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id;
    return [
      "sup",
      safeMergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "footnote-reference",
        class: "pixerate-footnote-ref",
        ...(id ? { id: `fnref-${id}` } : {}),
      }),
      ["a", id ? { href: `#fn-${id}` } : {}, String(node.attrs.number ?? "")],
    ];
  },

  renderText({ node }) {
    return `[${node.attrs.number ?? ""}]`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[^${node.attrs.number ?? node.attrs.id}]`);
        },
        parse: {
          setup(markdownit: any) {
            footnotesMarkdownIt(markdownit);
          },
          updateDOM(element: HTMLElement) {
            mergeFootnoteSections(element);
          },
        },
      },
    };
  },

  addCommands() {
    return {
      insertFootnote:
        (options = {}) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes[REFERENCE];
          if (!type || !state.schema.nodes[ITEM]) return false;
          const { $from } = state.selection;
          // Footnotes cannot contain footnotes.
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === LIST) return false;
          }
          if (!$from.parent.inlineContent) return false;
          if (!dispatch) return true;

          const id = options.id ?? this.options.generateId();
          tr.replaceSelectionWith(type.create({ id }), false);
          syncFootnotes(tr, {
            generateId: this.options.generateId,
            contents: options.content ? { [id]: options.content } : undefined,
          });
          const focusContent = options.focusContent ?? !options.content;
          if (focusContent) {
            const footnote = findFootnote(tr.doc, id);
            if (footnote) {
              tr.setSelection(TextSelection.create(tr.doc, footnote.pos + 2));
            }
          }
          tr.scrollIntoView();
          return true;
        },

      updateFootnote:
        (id, content) =>
        ({ state, tr, dispatch }) => {
          const footnote = findFootnote(state.doc, id);
          if (!footnote) return false;
          if (dispatch) {
            tr.replaceWith(
              footnote.pos + 1,
              footnote.pos + footnote.node.nodeSize - 1,
              paragraphsFromText(state.schema, content),
            );
          }
          return true;
        },

      deleteFootnote:
        (id) =>
        ({ state, tr, dispatch }) => {
          const refs = findReferences(state.doc, id);
          const footnote = findFootnote(state.doc, id);
          if (!refs.length && !footnote) return false;
          if (dispatch) {
            for (let i = refs.length - 1; i >= 0; i--) {
              tr.delete(refs[i].pos, refs[i].pos + refs[i].node.nodeSize);
            }
            syncFootnotes(tr, { generateId: this.options.generateId });
          }
          return true;
        },

      goToFootnote:
        (id) =>
        ({ state, tr, dispatch, view }) => {
          const footnote = findFootnote(state.doc, id);
          if (!footnote) return false;
          if (dispatch) {
            tr.setSelection(
              TextSelection.create(tr.doc, footnote.pos + footnote.node.nodeSize - 2),
            );
            tr.scrollIntoView();
            scrollDomAtPos(view, footnote.pos);
          }
          return true;
        },

      goToFootnoteReference:
        (id) =>
        ({ state, tr, dispatch, view }) => {
          const [ref] = findReferences(state.doc, id);
          if (!ref) return false;
          if (dispatch) {
            tr.setSelection(NodeSelection.create(tr.doc, ref.pos));
            tr.scrollIntoView();
            scrollDomAtPos(view, ref.pos);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const generateId = this.options.generateId;
    const editor = this.editor;
    return [
      new Plugin<boolean>({
        key: footnotesPluginKey,
        state: presenceStateSpec([REFERENCE, LIST]),
        appendTransaction: (transactions, _oldState, newState: EditorState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (!footnotesPluginKey.getState(newState)) return null;
          const tr = newState.tr;
          return syncFootnotes(tr, { generateId }) ? tr : null;
        },
        props: {
          handleClickOn: (_view, _pos, node, _nodePos, event) => {
            if (node.type.name !== REFERENCE || !node.attrs.id) return false;
            const target = event.target as HTMLElement | null;
            if (!target?.closest?.("a")) return false;
            event.preventDefault();
            return editor.commands.goToFootnote(node.attrs.id);
          },
        },
      }),
    ];
  },

  onBeforeCreate() {
    const { generateId } = this.options;
    syncInitialContent(this.editor, (state) => {
      const tr = state.tr;
      return syncFootnotes(tr, { generateId }) ? tr : null;
    });
  },
});

/**
 * The footnotes list at the end of the document. Managed automatically by
 * `FootnoteReference`; you rarely create it directly.
 */
export const Footnotes = Node.create({
  name: LIST,
  group: "block",
  content: `${ITEM}+`,
  isolating: true,
  selectable: false,
  draggable: false,

  parseHTML() {
    return [{ tag: 'section[data-type="footnotes"]', contentElement: "ol", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      safeMergeAttributes(HTMLAttributes, {
        "data-type": "footnotes",
        class: "pixerate-footnotes",
        role: "doc-endnotes",
      }),
      ["ol", 0],
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: ProsemirrorNode) {
          node.forEach((footnote) => {
            const label = footnote.attrs.number ?? footnote.attrs.id;
            state.wrapBlock("    ", `[^${label}]: `, footnote, () =>
              state.renderContent(footnote),
            );
          });
        },
        parse: {},
      },
    };
  },
});

/**
 * A single footnote's content inside the `footnotes` list.
 */
export const Footnote = Node.create({
  name: ITEM,
  content: "paragraph+",
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-id"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.id
            ? { "data-id": attributes.id, id: `fn-${attributes.id}` }
            : {},
      },
      number: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute("data-number")) || null,
        renderHTML: (attributes: Record<string, any>) =>
          attributes.number ? { "data-number": attributes.number } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'li[data-type="footnote"]', priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "li",
      safeMergeAttributes(HTMLAttributes, {
        "data-type": "footnote",
        class: "pixerate-footnote",
      }),
      0,
    ];
  },

  addKeyboardShortcuts() {
    // Backspace at the start of a footnote would join it into the previous
    // footnote (or lift it out of the list); keep footnotes intact instead.
    const atFootnoteStart = () => {
      const { selection } = this.editor.state;
      if (!selection.empty) return false;
      const { $from } = selection;
      if ($from.parentOffset !== 0 || $from.depth < 2) return false;
      const footnote = $from.node($from.depth - 1);
      return footnote.type.name === ITEM && $from.index($from.depth - 1) === 0;
    };
    return {
      Backspace: () => atFootnoteStart(),
    };
  },
});
