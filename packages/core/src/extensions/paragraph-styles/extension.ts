import { Extension, Mark, type Editor } from "@tiptap/core";
import { safeMergeAttributes } from "../safe-merge-attributes";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as ProsemirrorNode, Mark as ProsemirrorMark } from "@tiptap/pm/model";
import {
  NORMAL_STYLE_ID,
  StyleRegistry,
  createStyleRegistry,
  isValidStyleId,
  type CharacterFormat,
  type ParagraphFormat,
  type StyleDefinition,
  type StyleRegistrySnapshot,
} from "./registry";

/** Node attribute naming a block's paragraph style (`data-style` in HTML). */
export const STYLE_ID_ATTRIBUTE = "styleId";
/** Mark applying a character style (`<span data-char-style>`). */
export const CHARACTER_STYLE_MARK_NAME = "characterStyle";

export interface ParagraphStylesOptions {
  /** The style registry. Defaults to a new registry with the built-in styles per editor. */
  registry: StyleRegistry | null;
  /** Block types that carry the `styleId` attribute. */
  types: string[];
  /**
   * Inject a `<style>` element with `registry.toCSS({ scope })` while the
   * editor exists (kept up to date). Default `true`.
   */
  injectCSS: boolean;
  /** Selector the injected CSS is scoped to. Default `.ProseMirror`. */
  cssScope: string;
  /** Nonce of the injected `<style>` element (Content Security Policy). */
  cssNonce?: string;
  /**
   * Applying a paragraph style to a partial selection inside one paragraph
   * applies its linked character style instead (as in Word). Default `true`.
   */
  linkedCharacterStyles: boolean;
}

export interface ParagraphStylesStorage {
  registry: StyleRegistry;
}

export interface CreateStyleFromSelectionOptions {
  /** Id of the new style. Default: derived from the name. */
  id?: string;
  /** Base style. Default: the style at the selection. */
  basedOn?: string | null;
  /** Apply the new style to the selected paragraphs. Default `true`. */
  apply?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphStyles: {
      /** Applies a paragraph style to the selected blocks (changing headings/code blocks as the style needs). */
      setParagraphStyle: (id: string) => ReturnType;
      /** Resets the selected blocks to the Normal style. */
      clearParagraphStyle: () => ReturnType;
      /** Applies a character style to the selection. */
      setCharacterStyle: (id: string) => ReturnType;
      unsetCharacterStyle: () => ReturnType;
      /**
       * Updates a style (default: the style at the selection) to the direct
       * formatting at the selection ("Update to match selection").
       */
      updateParagraphStyleFromSelection: (id?: string) => ReturnType;
      /** Creates a paragraph style from the formatting at the selection ("New style from selection"). */
      createParagraphStyleFromSelection: (
        name: string,
        options?: CreateStyleFromSelectionOptions,
      ) => ReturnType;
    };
  }
}

export const paragraphStylesPluginKey = new PluginKey("paragraphStyles");

/** The style registry of an editor using `ParagraphStyles`. */
export function getStyleRegistry(editor: Editor | null | undefined): StyleRegistry | null {
  return (editor?.storage as any)?.paragraphStyles?.registry ?? null;
}

/** Heading levels the editor's heading node renders (all levels when unknown). */
function headingLevels(editor: Editor | null | undefined): number[] | null {
  const heading = editor?.extensionManager?.extensions.find((e) => e.name === "heading");
  const levels = heading?.options?.levels;
  return Array.isArray(levels) ? levels : null;
}

/**
 * Whether a paragraph style can be applied in this editor: its block type is
 * in the schema (and, for headings, its level is configured).
 */
export function isParagraphStyleAvailable(editor: Editor, registry: StyleRegistry, id: string): boolean {
  const style = registry.get(id);
  if (!style || style.kind !== "paragraph") return false;
  const block = registry.resolve(id).block;
  if (!editor.schema.nodes[block.type]) return false;
  if (block.type === "heading") {
    const levels = headingLevels(editor);
    if (levels && !levels.includes(Number(block.attrs?.level))) return false;
  }
  return true;
}

/** The paragraph style of the textblock at `pos` (defaults to the selection start). */
export function getParagraphStyleAt(
  state: EditorState,
  registry: StyleRegistry,
  pos: number = state.selection.from,
): string | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  return registry.styleOfBlock(block.type.name, block.attrs);
}

const MARK_FORMAT: Record<string, keyof CharacterFormat> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strike",
};

/** Marks common to all text in the selection (or at the caret). */
function selectionMarks(state: EditorState): readonly ProsemirrorMark[] {
  const { from, to, empty, $from } = state.selection;
  if (empty) return state.storedMarks ?? $from.marks();
  let common: readonly ProsemirrorMark[] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    common = common === null ? node.marks : common.filter((m) => m.isInSet(node.marks));
    return false;
  });
  return common ?? $from.marks();
}

/**
 * The direct formatting at the selection, as style formats: bold, italic,
 * underline, strike, font family/size, color and highlight from marks, and
 * the alignment of the block.
 */
export function captureSelectionFormat(state: EditorState): {
  paragraph: ParagraphFormat;
  character: CharacterFormat;
} {
  const character: CharacterFormat = {};
  selectionMarks(state).forEach((mark) => {
    const name = mark.type.name;
    if (MARK_FORMAT[name]) (character as any)[MARK_FORMAT[name]] = true;
    if (name === "textStyle") {
      if (mark.attrs.fontFamily) character.fontFamily = mark.attrs.fontFamily;
      if (mark.attrs.fontSize) character.fontSize = mark.attrs.fontSize;
      if (mark.attrs.color) character.color = mark.attrs.color;
    }
    if (name === "highlight") character.backgroundColor = mark.attrs.color || "#fef08a";
  });
  const paragraph: ParagraphFormat = {};
  const align = state.selection.$from.parent.attrs?.textAlign;
  if (align && align !== "left") paragraph.textAlign = align;
  return { paragraph, character };
}

/** Attributes of `node` that the target type also has (alignment, ids, …). */
function carriedAttributes(node: ProsemirrorNode, type: ProsemirrorNode["type"]): Record<string, any> {
  const spec = type.spec.attrs ?? {};
  return Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key in spec));
}

/**
 * Sets the block at `pos` to style `id`: its node type and attributes follow
 * the style's block, `styleId` is omitted when the style is the block's
 * default (Normal paragraphs, Heading N headings), and alignment is reset to
 * the style's.
 */
function applyStyleToBlock(
  tr: Transaction,
  pos: number,
  id: string,
  registry: StyleRegistry,
): boolean {
  const node = tr.doc.nodeAt(pos);
  if (!node || !node.isTextblock) return false;
  const resolved = registry.resolve(id);
  const type = tr.doc.type.schema.nodes[resolved.block.type];
  if (!type) return false;
  const blockAttrs = resolved.block.attrs ?? {};
  const isDefault = registry.defaultStyleFor(resolved.block.type, blockAttrs) === id;
  const attrs: Record<string, any> = { ...carriedAttributes(node, type), ...blockAttrs };
  if (STYLE_ID_ATTRIBUTE in (type.spec.attrs ?? {})) attrs[STYLE_ID_ATTRIBUTE] = isDefault ? null : id;
  if ("textAlign" in (type.spec.attrs ?? {})) {
    // Direct alignment is reset so the style's (from the stylesheet) shows.
    // With a non-null default alignment, TextAlign renders it inline, which
    // would hide the stylesheet's, so the style's alignment is set directly.
    const fallback = type.spec.attrs!.textAlign.default ?? null;
    attrs.textAlign = fallback === null ? null : resolved.paragraph.textAlign ?? fallback;
  }
  if (node.type === type && Object.entries(attrs).every(([k, v]) => node.attrs[k] === v)) return false;
  try {
    tr.setNodeMarkup(pos, type, attrs);
  } catch {
    // Content that does not fit the new type (e.g. marks in a code block).
    try {
      tr.setBlockType(pos + 1, pos + 1, type, attrs);
    } catch {
      return false;
    }
  }
  return true;
}

/** Textblocks touched by the selection, as positions. */
function selectedBlocks(state: EditorState): number[] {
  const { from, to } = state.selection;
  const positions: number[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      positions.push(pos);
      return false;
    }
    return true;
  });
  if (positions.length === 0 && state.selection.$from.parent.isTextblock) {
    positions.push(state.selection.$from.before());
  }
  return positions;
}

function setParagraphStyle(
  tr: Transaction,
  state: EditorState,
  id: string,
  registry: StyleRegistry,
): void {
  const start = tr.steps.length;
  selectedBlocks(state).forEach((pos) => {
    applyStyleToBlock(tr, tr.mapping.slice(start).map(pos), id, registry);
  });
}

/**
 * Applies the style named by `next` to the block created by pressing Enter
 * at the end of a styled paragraph. Runs on the resulting state, so it
 * works with every Enter implementation (splitBlock, list keymaps, …).
 */
function nextStyleTransaction(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  registry: StyleRegistry,
): Transaction | null {
  if (transactions.length !== 1) return null;
  const [tr] = transactions;
  if (!tr.docChanged || tr.getMeta("uiEvent") || tr.getMeta("history$") || tr.getMeta("y-sync$")) {
    return null;
  }
  const old = oldState.selection;
  const $old = old.$from;
  if (!old.empty || !$old.parent.isTextblock || $old.parent.type.spec.code) return null;
  if ($old.parentOffset !== $old.parent.content.size) return null;
  if (newState.doc.content.size !== oldState.doc.content.size + 2) return null;
  const $new = newState.selection.$from;
  if (!newState.selection.empty || !$new.parent.isTextblock || $new.parent.content.size !== 0) return null;
  const depth = $new.depth;
  const index = $new.index(depth - 1);
  if (index === 0 || $new.depth !== $old.depth) return null;
  const previous = $new.node(depth - 1).child(index - 1);
  if (!previous.isTextblock || !previous.eq($old.parent)) return null;

  const style = registry.styleOfBlock($old.parent.type.name, $old.parent.attrs);
  if (!style) return null;
  const next = registry.nextStyleId(style);
  const current = registry.styleOfBlock($new.parent.type.name, $new.parent.attrs);
  const target = registry.resolve(next).block;
  const typeMatches =
    $new.parent.type.name === target.type &&
    Object.entries(target.attrs ?? {}).every(([k, v]) => $new.parent.attrs[k] === v);
  if (current === next && typeMatches) return null;
  const out = newState.tr;
  if (!applyStyleToBlock(out, $new.before(), next, registry)) return null;
  return out;
}

/** Character style applied to a run of text. */
export const CharacterStyle = Mark.create({
  name: CHARACTER_STYLE_MARK_NAME,
  addAttributes() {
    return {
      [STYLE_ID_ATTRIBUTE]: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const id = el.getAttribute("data-char-style");
          return isValidStyleId(id) ? id : null;
        },
        renderHTML: (attrs: Record<string, any>) =>
          attrs[STYLE_ID_ATTRIBUTE] ? { "data-char-style": attrs[STYLE_ID_ATTRIBUTE] } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-char-style]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", safeMergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * Paragraph styles (Normal, Title, Heading 1, …) from a `StyleRegistry`:
 * a `styleId` attribute on paragraphs and headings (`data-style` in HTML),
 * a `characterStyle` mark, apply/clear/update/create commands, next-style
 * on Enter and an injected stylesheet. Headings without a `styleId` use
 * Heading N, plain paragraphs Normal, so existing documents are unchanged.
 */
export const ParagraphStyles = Extension.create<ParagraphStylesOptions, ParagraphStylesStorage>({
  name: "paragraphStyles",

  addOptions() {
    return {
      registry: null,
      types: ["paragraph", "heading", "codeBlock"],
      injectCSS: true,
      cssScope: ".ProseMirror",
      cssNonce: undefined,
      linkedCharacterStyles: true,
    };
  },

  addStorage() {
    return { registry: this.options.registry ?? createStyleRegistry() };
  },

  addExtensions() {
    return [CharacterStyle];
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          [STYLE_ID_ATTRIBUTE]: {
            default: null,
            keepOnSplit: true,
            parseHTML: (el: HTMLElement) => {
              const id = el.getAttribute("data-style");
              return isValidStyleId(id) ? id : null;
            },
            renderHTML: (attrs: Record<string, any>) => {
              const id = attrs[STYLE_ID_ATTRIBUTE];
              return isValidStyleId(id) ? { "data-style": id, class: `pixerate-style-${id}` } : {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    const registry = () => this.storage.registry;
    const editor = () => this.editor;
    return {
      setParagraphStyle:
        (id) =>
        ({ state, tr, dispatch }) => {
          const reg = registry();
          if (!isParagraphStyleAvailable(editor(), reg, id)) return false;
          const { $from, $to, empty } = state.selection;
          const linked = this.options.linkedCharacterStyles ? reg.linkedCharacterStyle(id) : undefined;
          const partial =
            !empty &&
            $from.sameParent($to) &&
            $from.parent.isTextblock &&
            ($from.parentOffset > 0 || $to.parentOffset < $from.parent.content.size);
          const markType = state.schema.marks[CHARACTER_STYLE_MARK_NAME];
          if (partial && linked && markType) {
            if (dispatch) {
              tr.addMark($from.pos, $to.pos, markType.create({ [STYLE_ID_ATTRIBUTE]: linked.id }));
            }
            return true;
          }
          if (dispatch) setParagraphStyle(tr, state, id, reg);
          return true;
        },
      clearParagraphStyle:
        () =>
        ({ commands }) =>
          commands.setParagraphStyle(NORMAL_STYLE_ID),
      setCharacterStyle:
        (id) =>
        ({ commands }) => {
          if (registry().get(id)?.kind !== "character") return false;
          return commands.setMark(CHARACTER_STYLE_MARK_NAME, { [STYLE_ID_ATTRIBUTE]: id });
        },
      unsetCharacterStyle:
        () =>
        ({ commands }) =>
          commands.unsetMark(CHARACTER_STYLE_MARK_NAME),
      updateParagraphStyleFromSelection:
        (id) =>
        ({ state, dispatch }) => {
          const reg = registry();
          const target = id ?? getParagraphStyleAt(state, reg);
          const style = target ? reg.get(target) : undefined;
          if (!style || style.kind !== "paragraph") return false;
          if (dispatch) {
            const captured = captureSelectionFormat(state);
            reg.update(style.id, captured);
          }
          return true;
        },
      createParagraphStyleFromSelection:
        (name, options = {}) =>
        ({ state, tr, dispatch }) => {
          const reg = registry();
          const trimmed = name.trim();
          if (!trimmed) return false;
          const id = options.id ?? reg.newId(trimmed);
          if (!isValidStyleId(id) || reg.get(id)) return false;
          const basedOn =
            options.basedOn === undefined ? getParagraphStyleAt(state, reg) : options.basedOn;
          if (dispatch) {
            const captured = captureSelectionFormat(state);
            const definition: StyleDefinition = {
              id,
              name: trimmed,
              kind: "paragraph",
              basedOn: basedOn ?? NORMAL_STYLE_ID,
              paragraph: captured.paragraph,
              character: captured.character,
              priority: 50,
              quick: true,
            };
            reg.upsert(definition);
            if (options.apply !== false) setParagraphStyle(tr, state, id, reg);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const registry = this.storage.registry;
    return [
      new Plugin({
        key: paragraphStylesPluginKey,
        appendTransaction: (transactions, oldState, newState) =>
          nextStyleTransaction(transactions, oldState, newState, registry),
      }),
    ];
  },

  onBeforeCreate() {
    if (!this.options.injectCSS || typeof document === "undefined") return;
    const element = document.createElement("style");
    element.setAttribute("data-pixerate-paragraph-styles", "");
    if (this.options.cssNonce) element.nonce = this.options.cssNonce;
    document.head.appendChild(element);
    const scope = this.options.cssScope;
    const unsubscribe = this.storage.registry.subscribe(() => {
      element.textContent = this.storage.registry.toCSS({ scope });
    });
    (this.storage as any).cleanup = () => {
      unsubscribe();
      element.remove();
    };
  },

  onDestroy() {
    (this.storage as any).cleanup?.();
  },
});

// ---------------------------------------------------------------------------
// Store for UI bindings
// ---------------------------------------------------------------------------

export interface ParagraphStylesSnapshot {
  /** Paragraph styles for the gallery (quick, not hidden, available in this editor). */
  gallery: readonly StyleDefinition[];
  /** All paragraph styles available in this editor. */
  styles: readonly StyleDefinition[];
  /** Character styles. */
  characterStyles: readonly StyleDefinition[];
  /** The style of the block at the selection. */
  currentStyleId: string | null;
  /** Registry version (changes when styles change). */
  version: number;
}

export interface ParagraphStylesStore {
  getSnapshot(): ParagraphStylesSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

const EMPTY_STYLES: ParagraphStylesSnapshot = Object.freeze({
  gallery: [],
  styles: [],
  characterStyles: [],
  currentStyleId: null,
  version: -1,
}) as ParagraphStylesSnapshot;

/**
 * External store over an editor's paragraph styles and the style at the
 * selection, for `useSyncExternalStore` and Svelte runes. Snapshots change
 * only when the styles or the current style change. Listeners are attached
 * to the editor only while subscribed.
 */
export function createParagraphStylesStore(editor: Editor | null | undefined): ParagraphStylesStore {
  const registry = getStyleRegistry(editor);
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_STYLES;
  let unsubscribeRegistry: (() => void) | null = null;

  const compute = (): ParagraphStylesSnapshot => {
    if (!editor || editor.isDestroyed || !registry) return EMPTY_STYLES;
    const { version } = registry.getSnapshot();
    const currentStyleId = getParagraphStyleAt(editor.state, registry);
    if (snapshot.version === version && snapshot.currentStyleId === currentStyleId) return snapshot;
    if (snapshot.version === version) return { ...snapshot, currentStyleId };
    const styles = registry
      .list("paragraph")
      .filter((style) => !style.hidden && isParagraphStyleAvailable(editor, registry, style.id));
    return {
      gallery: styles.filter((style) => style.quick),
      styles,
      characterStyles: registry.list("character").filter((style) => !style.hidden),
      currentStyleId,
      version,
    };
  };

  const update = () => {
    const next = compute();
    if (next !== snapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    }
  };

  const detach = () => {
    editor?.off("transaction", update);
    unsubscribeRegistry?.();
    unsubscribeRegistry = null;
  };

  return {
    getSnapshot: () => {
      if (!listeners.size) snapshot = compute();
      return snapshot;
    },
    subscribe(listener) {
      if (!listeners.size) {
        snapshot = compute();
        editor?.on("transaction", update);
        unsubscribeRegistry = registry ? registry.subscribe(update) : null;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) detach();
      };
    },
    destroy() {
      detach();
      listeners.clear();
    },
  };
}

export type { StyleRegistrySnapshot };
