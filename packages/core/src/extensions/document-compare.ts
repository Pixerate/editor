import { Extension, type Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  compareDocuments,
  type CompareDocumentsOptions,
  type CompareDocumentsResult,
  type CompareSource,
} from "../compare/documents";
import { TRACK_CHANGES_SKIP_META, trackChangesPluginKey } from "./track-changes";

/** Options of a comparison run in an editor (the schema is the editor's). */
export type EditorCompareOptions = Omit<CompareDocumentsOptions, "schema">;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    documentCompare: {
      /**
       * Replaces the content with the comparison of `original` and
       * `revised` (nodes, JSON or HTML) as tracked changes. The content is
       * set without being tracked; the summary is stored in
       * `editor.storage.documentCompare.lastResult`.
       */
      setContentFromComparison: (
        original: CompareSource,
        revised: CompareSource,
        options?: EditorCompareOptions,
      ) => ReturnType;
    };
  }
}

export interface DocumentCompareOptions {
  /** Defaults for every comparison (author defaults to the track-changes author). */
  compare: EditorCompareOptions;
}

export interface DocumentCompareStorage {
  lastResult: CompareDocumentsResult | null;
}

function trackChangesAuthor(state: EditorState) {
  return trackChangesPluginKey.getState(state)?.author;
}

/**
 * Compares two versions in the editor's schema and returns the result
 * without changing the editor. The author defaults to the `TrackChanges`
 * author.
 */
export function compareInEditor(
  editor: Editor,
  original: CompareSource,
  revised: CompareSource,
  options: EditorCompareOptions = {},
): CompareDocumentsResult {
  return compareDocuments(original, revised, {
    ...options,
    author: options.author ?? trackChangesAuthor(editor.state),
    schema: editor.schema,
  });
}

/**
 * Compares two versions and replaces the editor content with the result
 * (one undoable step, not tracked). Works without the `DocumentCompare`
 * extension; the schema needs `TrackChanges`.
 */
export function applyDocumentComparison(
  editor: Editor,
  original: CompareSource,
  revised: CompareSource,
  options: EditorCompareOptions = {},
): CompareDocumentsResult {
  const result = compareInEditor(editor, original, revised, options);
  const { state } = editor;
  const tr = state.tr.replaceWith(0, state.doc.content.size, result.doc.content);
  tr.setMeta(TRACK_CHANGES_SKIP_META, true);
  editor.view.dispatch(tr);
  return result;
}

/** Adds the `setContentFromComparison` command. Requires `TrackChanges`. */
export const DocumentCompare = Extension.create<DocumentCompareOptions, DocumentCompareStorage>({
  name: "documentCompare",

  addOptions() {
    return { compare: {} };
  },

  addStorage() {
    return { lastResult: null };
  },

  addCommands() {
    return {
      setContentFromComparison:
        (original, revised, options = {}) =>
        ({ state, tr, dispatch }) => {
          const merged = { ...this.options.compare, ...options };
          const result = compareDocuments(original, revised, {
            ...merged,
            author: merged.author ?? trackChangesAuthor(state),
            schema: state.schema,
          });
          if (dispatch) {
            tr.replaceWith(0, tr.doc.content.size, result.doc.content);
            tr.setMeta(TRACK_CHANGES_SKIP_META, true);
            this.storage.lastResult = result;
          }
          return true;
        },
    };
  },
});
