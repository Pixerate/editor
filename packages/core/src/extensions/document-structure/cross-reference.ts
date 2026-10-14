import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { getBookmarks } from "./bookmarks";
import { computeOutline } from "./outline";
import {
  presenceStateSpec,
  scrollDomAtPos,
  STRUCTURE_PRIORITY,
  syncInitialContent,
} from "./utils";

export type CrossReferenceTargetType = "heading" | "bookmark";

/**
 * Something a cross-reference can point to.
 */
export interface CrossReferenceTarget {
  type: CrossReferenceTargetType;
  id: string;
  /** Current text of the target (heading text or bookmarked text). */
  text: string;
  /** Bookmark name, or heading text. */
  name: string;
  /** Heading level (headings only). */
  level?: number;
}

export interface CrossReferenceOptions {
  HTMLAttributes: Record<string, any>;
  /** Heading node types that can be referenced. Defaults to `["heading"]`. */
  headingTypes: string[];
  /** Text shown while the target no longer exists (Word: "Error! Reference source not found."). */
  brokenText: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    crossReference: {
      /** Inserts a cross-reference to a heading or bookmark at the selection. */
      insertCrossReference: (target: {
        targetType: CrossReferenceTargetType;
        targetId: string;
      }) => ReturnType;
      /**
       * Moves the caret to the target of the cross-reference at `pos` (or the
       * selected cross-reference).
       */
      followCrossReference: (pos?: number) => ReturnType;
    };
  }
}

export const crossReferencePluginKey = new PluginKey<boolean>("crossReference");

const NAME = "crossReference";

/**
 * Lists the headings (with stable ids, see `Outline`) and bookmarks in a
 * document, for building a cross-reference picker.
 */
export function getCrossReferenceTargets(
  doc: ProsemirrorNode,
  headingTypes: readonly string[] = ["heading"],
): CrossReferenceTarget[] {
  const headings: CrossReferenceTarget[] = computeOutline(doc, headingTypes)
    .filter((h) => !h.id.startsWith("outline-"))
    .map((h) => ({ type: "heading", id: h.id, text: h.text, name: h.text, level: h.level }));
  const bookmarks: CrossReferenceTarget[] = getBookmarks(doc).map((b) => ({
    type: "bookmark",
    id: b.id,
    text: b.text,
    name: b.name,
  }));
  return [...headings, ...bookmarks];
}

interface TargetLookup {
  targets: Map<string, CrossReferenceTarget>;
  headingsByText: Map<string, CrossReferenceTarget>;
}

/**
 * Updates every cross-reference's cached `label` and `broken` state from its
 * target. A heading reference whose id disappeared (e.g. after a markdown
 * round-trip, which does not keep heading ids) is re-pointed at a heading with
 * exactly the same text, if there is one.
 */
function syncCrossReferences(
  state: EditorState,
  headingTypes: readonly string[],
): Transaction | null {
  let lookup: TargetLookup | null = null;
  const resolve = (): TargetLookup => {
    if (!lookup) {
      const next: TargetLookup = { targets: new Map(), headingsByText: new Map() };
      for (const t of getCrossReferenceTargets(state.doc, headingTypes)) {
        next.targets.set(`${t.type}:${t.id}`, t);
        if (t.type === "heading" && !next.headingsByText.has(t.text)) {
          next.headingsByText.set(t.text, t);
        }
      }
      lookup = next;
    }
    return lookup;
  };

  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== NAME) return true;
    const { targets, headingsByText } = resolve();
    const { targetType } = node.attrs;
    let { targetId } = node.attrs;
    let target = targets.get(`${targetType}:${targetId}`);
    if (!target && targetType === "heading" && node.attrs.label) {
      target = headingsByText.get(node.attrs.label);
      if (target) targetId = target.id;
    }
    const label = target ? target.text : node.attrs.label;
    const broken = !target;
    if (
      label !== node.attrs.label ||
      broken !== node.attrs.broken ||
      targetId !== node.attrs.targetId
    ) {
      tr = tr ?? state.tr;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, targetId, label, broken });
    }
    return false;
  });
  return tr;
}

/**
 * Inline cross-reference to a heading or bookmark. It displays the target's
 * current text, follows renames, and switches to a broken-reference state
 * (class `is-broken`, `brokenText`) when the target is removed. Undoing the
 * removal restores it. Heading targets need the `Outline` extension, which
 * gives headings stable ids.
 */
export const CrossReference = Node.create<CrossReferenceOptions>({
  name: NAME,
  priority: STRUCTURE_PRIORITY - 5,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      headingTypes: ["heading"],
      brokenText: "Error! Reference source not found.",
    };
  },

  addAttributes() {
    return {
      targetType: {
        default: "heading",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-target-type") ?? "heading",
        renderHTML: (attributes: Record<string, any>) => ({
          "data-target-type": attributes.targetType,
        }),
      },
      targetId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-target-id"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.targetId ? { "data-target-id": attributes.targetId } : {},
      },
      label: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-label") ?? element.textContent ?? "",
        renderHTML: (attributes: Record<string, any>) => ({
          "data-label": attributes.label,
        }),
      },
      broken: {
        default: false,
        parseHTML: (element: HTMLElement) => element.hasAttribute("data-broken"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.broken ? { "data-broken": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-type="cross-reference"]', priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { targetType, targetId, broken, label } = node.attrs;
    const href =
      !broken && targetType === "heading" && targetId ? { href: `#${targetId}` } : {};
    return [
      "a",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, href, {
        "data-type": "cross-reference",
        class: broken ? "pixerate-cross-reference is-broken" : "pixerate-cross-reference",
      }),
      broken ? this.options.brokenText : label,
    ];
  },

  renderText({ node }) {
    return node.attrs.broken ? this.options.brokenText : node.attrs.label;
  },

  addCommands() {
    return {
      insertCrossReference:
        ({ targetType, targetId }) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes[NAME];
          if (!type || !state.selection.$from.parent.inlineContent) return false;
          const target = getCrossReferenceTargets(state.doc, this.options.headingTypes).find(
            (t) => t.type === targetType && t.id === targetId,
          );
          if (!target) return false;
          if (dispatch) {
            tr.replaceSelectionWith(
              type.create({ targetType, targetId, label: target.text, broken: false }),
              false,
            );
          }
          return true;
        },

      followCrossReference:
        (pos) =>
        ({ state, tr, dispatch, view }) => {
          const node =
            pos != null ? state.doc.nodeAt(pos) : (state.selection as any).node ?? null;
          if (!node || node.type.name !== NAME || node.attrs.broken) return false;
          const { targetType, targetId } = node.attrs;
          let range: { from: number; to: number; blockPos: number } | null = null;
          if (targetType === "bookmark") {
            const bookmark = getBookmarks(state.doc).find((b) => b.id === targetId);
            if (bookmark) {
              const $from = state.doc.resolve(bookmark.from);
              range = {
                from: bookmark.from,
                to: bookmark.to,
                blockPos: $from.before($from.depth),
              };
            }
          } else {
            const heading = computeOutline(state.doc, this.options.headingTypes).find(
              (h) => h.id === targetId,
            );
            if (heading) {
              range = { from: heading.pos + 1, to: heading.pos + 1, blockPos: heading.pos };
            }
          }
          if (!range) return false;
          if (dispatch) {
            tr.setSelection(TextSelection.create(tr.doc, range.from, range.to));
            tr.scrollIntoView();
            scrollDomAtPos(view, range.blockPos);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { headingTypes } = this.options;
    const editor = this.editor;
    return [
      new Plugin<boolean>({
        key: crossReferencePluginKey,
        state: presenceStateSpec([NAME]),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (!crossReferencePluginKey.getState(newState)) return null;
          return syncCrossReferences(newState, headingTypes);
        },
        props: {
          handleClickOn: (_view, _pos, node, nodePos, event) => {
            if (node.type.name !== NAME) return false;
            // Follow on Ctrl/Cmd+click while editing (like Word), plain click when read-only.
            if (editor.isEditable && !(event.metaKey || event.ctrlKey)) return false;
            event.preventDefault();
            return editor.commands.followCrossReference(nodePos);
          },
        },
      }),
    ];
  },

  onBeforeCreate() {
    const { headingTypes } = this.options;
    syncInitialContent(this.editor, (state) => syncCrossReferences(state, headingTypes));
  },
});
