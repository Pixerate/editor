import { Node, mergeAttributes } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { computeOutline, outlinePluginKey, type OutlineHeading } from "./outline";
import { tableOfContentsMarkdownIt } from "./markdown-it";
import {
  arraysEqual,
  presenceStateSpec,
  scrollDomAtPos,
  STRUCTURE_PRIORITY,
  syncInitialContent,
} from "./utils";

/**
 * An entry rendered by a table of contents node.
 */
export interface TableOfContentsEntry {
  id: string | null;
  level: number;
  text: string;
  depth: number;
}

export interface TableOfContentsOptions {
  HTMLAttributes: Record<string, any>;
  /** Heading node types to list. Defaults to `["heading"]`. */
  headingTypes: string[];
  /** Default title for newly inserted tables of contents. */
  defaultTitle: string;
  /** Text shown when the document has no headings. */
  emptyText: string;
}

export interface InsertTableOfContentsOptions {
  title?: string;
  minLevel?: number;
  maxLevel?: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableOfContents: {
      /** Inserts a table of contents block at the selection. */
      insertTableOfContents: (
        options?: InsertTableOfContentsOptions,
      ) => ReturnType;
    };
  }
}

export const tableOfContentsPluginKey = new PluginKey<boolean>("tableOfContents");

const sameEntry = (a: TableOfContentsEntry, b: TableOfContentsEntry) =>
  a.id === b.id && a.level === b.level && a.text === b.text && a.depth === b.depth;

/**
 * Builds table of contents entries from an outline, limited to a level range.
 * Depth is recomputed within the range so the shallowest listed level is 0.
 */
export function getTableOfContentsEntries(
  headings: readonly OutlineHeading[],
  minLevel = 1,
  maxLevel = 6,
): TableOfContentsEntry[] {
  const entries: TableOfContentsEntry[] = [];
  const stack: number[] = [];
  for (const heading of headings) {
    if (heading.level < minLevel || heading.level > maxLevel) continue;
    while (stack.length && stack[stack.length - 1] >= heading.level) stack.pop();
    entries.push({
      // Fallback ids (`outline-n`) are not stored on the heading, so they
      // cannot be linked to.
      id: heading.id.startsWith("outline-") ? null : heading.id,
      level: heading.level,
      text: heading.text,
      depth: stack.length,
    });
    stack.push(heading.level);
  }
  return entries;
}

function syncTableOfContents(
  state: EditorState,
  headingTypes: readonly string[],
): Transaction | null {
  const headings =
    outlinePluginKey.getState(state) ?? computeOutline(state.doc, headingTypes);
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "tableOfContents") {
      const entries = getTableOfContentsEntries(
        headings,
        node.attrs.minLevel,
        node.attrs.maxLevel,
      );
      if (!arraysEqual(node.attrs.entries ?? [], entries, sameEntry)) {
        tr = tr ?? state.tr;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, entries });
      }
      return false;
    }
    return !node.isTextblock;
  });
  return tr;
}

/**
 * Table of contents block. An atom node whose entries mirror the document's
 * headings; they are refreshed on every document change, so exported HTML
 * always contains the current, linked list. Install the `Outline` extension
 * alongside it so headings get stable ids to link to.
 *
 * Markdown: serialized as a `[[toc]]` line and parsed back from `[[toc]]` or
 * `[TOC]`.
 */
export const TableOfContents = Node.create<TableOfContentsOptions>({
  name: "tableOfContents",
  priority: STRUCTURE_PRIORITY - 5,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      headingTypes: ["heading"],
      defaultTitle: "Contents",
      emptyText: "Add headings to build the table of contents.",
    };
  },

  addAttributes() {
    return {
      title: {
        default: this.options.defaultTitle,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-title") ?? this.options.defaultTitle,
        renderHTML: (attributes: Record<string, any>) => ({
          "data-title": attributes.title,
        }),
      },
      minLevel: {
        default: 1,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute("data-min-level")) || 1,
        renderHTML: (attributes: Record<string, any>) => ({
          "data-min-level": attributes.minLevel,
        }),
      },
      maxLevel: {
        default: 3,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute("data-max-level")) || 3,
        renderHTML: (attributes: Record<string, any>) => ({
          "data-max-level": attributes.maxLevel,
        }),
      },
      entries: {
        default: [],
        rendered: false,
        // Entries are derived from the headings and recomputed after parsing.
        parseHTML: () => [],
      },
    };
  },

  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]', priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const entries: TableOfContentsEntry[] = node.attrs.entries ?? [];
    const list = entries.length
      ? [
          "ol",
          { class: "toc-list" },
          ...entries.map((entry) => [
            "li",
            {
              class: "toc-entry",
              "data-level": entry.level,
              "data-depth": entry.depth,
              style: `margin-left: ${entry.depth * 1.25}em`,
            },
            entry.id
              ? ["a", { href: `#${entry.id}`, "data-heading-id": entry.id }, entry.text]
              : ["span", {}, entry.text],
          ]),
        ]
      : ["p", { class: "toc-empty" }, this.options.emptyText];

    return [
      "nav",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "table-of-contents",
        "aria-label": node.attrs.title || "Table of contents",
        class: "pixerate-toc",
      }),
      ["p", { class: "toc-title" }, node.attrs.title ?? ""],
      list,
    ];
  },

  renderText({ node }) {
    const entries: TableOfContentsEntry[] = node.attrs.entries ?? [];
    return [node.attrs.title, ...entries.map((e) => `${"  ".repeat(e.depth)}${e.text}`)]
      .filter(Boolean)
      .join("\n");
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write("[[toc]]");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: any) {
            tableOfContentsMarkdownIt(markdownit);
          },
        },
      },
    };
  },

  addCommands() {
    return {
      insertTableOfContents:
        (options = {}) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              title: options.title ?? this.options.defaultTitle,
              minLevel: options.minLevel ?? 1,
              maxLevel: options.maxLevel ?? 3,
            },
          }),
    };
  },

  addProseMirrorPlugins() {
    const { headingTypes } = this.options;
    const editor = this.editor;
    return [
      new Plugin<boolean>({
        key: tableOfContentsPluginKey,
        state: presenceStateSpec([this.name]),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (!tableOfContentsPluginKey.getState(newState)) return null;
          return syncTableOfContents(newState, headingTypes);
        },
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              const target = event.target as HTMLElement | null;
              const link = target?.closest?.(
                'nav[data-type="table-of-contents"] a[data-heading-id]',
              );
              if (!link) return false;
              event.preventDefault();
              const id = link.getAttribute("data-heading-id");
              const heading = (
                outlinePluginKey.getState(view.state) ??
                computeOutline(view.state.doc, headingTypes)
              ).find((h) => h.id === id);
              if (!heading) return true;
              if (editor.isEditable) {
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, heading.pos + 1))
                    .scrollIntoView(),
                );
                view.focus();
              }
              scrollDomAtPos(view, heading.pos);
              return true;
            },
          },
        },
      }),
    ];
  },

  onBeforeCreate() {
    const { headingTypes } = this.options;
    syncInitialContent(this.editor, (state) => syncTableOfContents(state, headingTypes));
  },
});
