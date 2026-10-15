import { DOMParser as PMDOMParser, Slice, type Schema } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { plainTextToSlice } from "../serializers/plain-text";
import { insertSliceAfterTable, outermostTableDepth, sliceContainsTable } from "../extensions/table/nesting";
import { defaultImportRegistry, type DocumentImport } from "./adapters";
import type { FileLike, ImportAdapterRegistry, ImportOutcome } from "./registry";

/** A TipTap `Editor` (or anything with a `view`) or a ProseMirror `EditorView`. */
export type ImportEditorTarget = EditorView | { view: EditorView };

const toView = (target: ImportEditorTarget): EditorView =>
  "state" in target && "dispatch" in target ? (target as EditorView) : (target as { view: EditorView }).view;

/**
 * Parses (already sanitized) HTML into a slice for `schema`. The HTML is
 * parsed with `DOMParser`, which produces an inert document: images don't
 * load and handlers don't run. Returns `null` without a DOM.
 */
export function htmlToSlice(html: string, schema: Schema): Slice | null {
  const Parser: typeof DOMParser | undefined =
    (globalThis as any).DOMParser ?? (globalThis as any).window?.DOMParser;
  if (!Parser) return null;
  const body = new Parser().parseFromString(`<body>${html}</body>`, "text/html").body;
  // A closed slice: imported blocks stay blocks instead of merging into the
  // paragraph at the insertion point (which `parseSlice`'s open slice does).
  return new Slice(PMDOMParser.fromSchema(schema).parse(body).content, 0, 0);
}

export interface InsertImportedDocumentOptions {
  /** Document position to insert at (default: replace the selection). */
  at?: number;
  /** Insert `text` literally instead of `html` (plain-text / prompt editors). */
  asPlainText?: boolean;
}

/**
 * Inserts an imported document into an editor as one transaction and returns
 * the position right after the inserted content. Content with a table that
 * would land in a table cell is inserted after the outermost table instead
 * (tables are never nested).
 */
export function insertImportedDocument(
  target: ImportEditorTarget,
  content: DocumentImport,
  options: InsertImportedDocumentOptions = {},
): number {
  const view = toView(target);
  const { state } = view;
  const htmlSlice = options.asPlainText ? null : htmlToSlice(content.html, state.schema);
  const size = state.doc.content.size;
  let from =
    options.at !== undefined ? Math.max(0, Math.min(options.at, size)) : state.selection.from;
  let to = options.at !== undefined ? from : state.selection.to;
  if (!htmlSlice && from === to && !state.doc.resolve(from).parent.inlineContent) {
    // Drop positions can fall between blocks; text belongs in the nearest textblock.
    from = to = Selection.near(state.doc.resolve(from)).from;
  }
  if (htmlSlice && sliceContainsTable(htmlSlice) && outermostTableDepth(state.doc.resolve(from)) >= 0) {
    // Tables are not nested: an import into a table cell goes after the
    // (outermost) table, and the cell keeps its content.
    const tr = state.tr;
    const end = insertSliceAfterTable(tr, from, to, htmlSlice);
    if (end !== null) {
      if (options.at === undefined) tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
      view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "drop"));
      return end;
    }
  }
  // Closed HTML blocks may replace an empty parent (`replaceRange`); plain text
  // is an open slice that merges into the current paragraph like a paste.
  const tr = htmlSlice
    ? state.tr.replaceRange(from, to, htmlSlice)
    : state.tr.replace(from, to, plainTextToSlice(content.text, state.schema));
  const end = tr.mapping.map(to, 1);
  view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "drop"));
  return end;
}

/**
 * Loads the review data of an import (DOCX comments and styles) into an
 * editor: threads are added to the `Comments` extension's store (existing
 * threads are kept) and styles the `ParagraphStyles` registry does not have
 * yet are added. Call it after inserting `content.html`;
 * `importFilesIntoEditor` does so for editors. Returns how many threads and
 * styles were added.
 */
export function applyImportedReviewData(
  editor: { storage?: unknown } | null | undefined,
  content: DocumentImport,
): { comments: number; styles: number } {
  const storage = (editor?.storage ?? {}) as any;
  let comments = 0;
  let styles = 0;
  const store = storage.comment?.store;
  const threads = content.comments?.threads ?? [];
  if (store && threads.length) {
    const existing = store.toJSON().threads as { id: string }[];
    const fresh = threads.filter((thread) => !existing.some((t) => t.id === thread.id));
    if (fresh.length) {
      store.load({ version: 1, threads: [...existing, ...fresh] });
      comments = fresh.length;
    }
  }
  const registry = storage.paragraphStyles?.registry;
  if (registry && content.styles) {
    for (const style of content.styles.list()) {
      if (registry.get(style.id)) continue;
      registry.upsert(style);
      styles++;
    }
  }
  return { comments, styles };
}

export interface ImportFilesIntoEditorOptions extends InsertImportedDocumentOptions {
  /** Registry to match files against (default: the shared default registry). */
  registry?: ImportAdapterRegistry;
  /** Per-adapter options keyed by adapter id, e.g. `{ pdf: { structure: false } }` (see `ImportFileOptions`). */
  adapterOptions?: Record<string, unknown>;
  /** Called after each file is inserted. */
  onImport?: (outcome: ImportOutcome<DocumentImport>, file: FileLike) => void;
  /** Called for each file that cannot be imported; other files continue. */
  onError?: (error: Error, file: FileLike) => void;
}

/**
 * Imports files with `document` adapters and inserts them one after another
 * at `at` (or the selection). Files without a matching adapter are reported
 * through `onError`. Resolves with the successful outcomes.
 */
export async function importFilesIntoEditor(
  target: ImportEditorTarget,
  files: Iterable<FileLike> | ArrayLike<FileLike>,
  options: ImportFilesIntoEditorOptions = {},
): Promise<ImportOutcome<DocumentImport>[]> {
  const registry = options.registry ?? defaultImportRegistry;
  const outcomes: ImportOutcome<DocumentImport>[] = [];
  let at = options.at;
  for (const file of Array.from(files as ArrayLike<FileLike>)) {
    try {
      const outcome = await registry.importFile<DocumentImport>(file, {
        target: "document",
        adapterOptions: options.adapterOptions,
      });
      const view = toView(target);
      if ((view as any).isDestroyed) break;
      at = insertImportedDocument(view, outcome.result, { at, asPlainText: options.asPlainText });
      if (!options.asPlainText && "storage" in (target as object)) {
        applyImportedReviewData(target as { storage?: unknown }, outcome.result);
      }
      outcomes.push(outcome);
      options.onImport?.(outcome, file);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.onError) options.onError(err, file);
      else console.error("[Editor] File import failed:", err);
    }
  }
  return outcomes;
}
