import { stripPrototypeKeys } from "../tools/safe-json";
import { createLoadReport, migrateDocument, type JsonObject, type LoadReport, type SectionProblem } from "./migrate";

/**
 * Undo / redo of an editor. Satisfies `HistoryCommandTarget`, so
 * `createHistoryCommands(doc.history)` works for every editor.
 */
export interface EditorDocumentHistory {
  /** Returns `false` when there was nothing to undo. */
  undo(): boolean;
  /** Returns `false` when there was nothing to redo. */
  redo(): boolean;
  getState(): { canUndo: boolean; canRedo: boolean; undoName?: string; redoName?: string };
}

export interface LoadEditorDocumentOptions {
  /**
   * `"reset"` (default) opens the document fresh and clears the undo stack.
   * `"record"` makes the load one undo step (agent loads); editors whose
   * `recordsLoads` is `false` reset instead.
   */
  history?: "reset" | "record";
}

/**
 * The save / load / undo contract every editor exposes (e.g.
 * `createDiagramEditorDocument(controller)`). Autosave
 * (`createEditorAutosave`), the agent tools (`createDocumentToolProvider`) and
 * the React / Svelte wrappers take it, so they work the same for every editor.
 */
export interface EditorDocument<T = unknown> {
  /** Editor domain, e.g. `"diagram"`; names the tools and storage keys (`[a-z][a-z0-9_]*`). */
  readonly kind: string;
  /** The format version `getDocument()` writes; older files are migrated on load. */
  readonly formatVersion: number;
  /** Whether `loadDocument(…, { history: "record" })` is one undo step. */
  readonly recordsLoads: boolean;
  /** Plain JSON snapshot of the whole document; `loadDocument(getDocument())` changes nothing. */
  getDocument(): T;
  /**
   * Replaces the document with a raw document or an `EditorDocumentFile`.
   * Validates and migrates first: throws `EditorDocumentLoadError` and changes
   * nothing when the input does not fit.
   */
  loadDocument(input: unknown, options?: LoadEditorDocumentOptions): LoadReport;
  /** Bumped on every document change, including undo, redo and load (not on selection). */
  revision(): number;
  /** Called after every document change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  readonly history: EditorDocumentHistory;
  /** Why the document cannot be changed (a sentence, e.g. "The diagram is read-only."), or `false`. */
  readOnly(): string | false;
  /** Stops listening to the editor; `subscribe` or `revision` reconnects (React StrictMode remounts). */
  destroy(): void;
}

/** Thrown by `loadDocument` / `parseEditorDocument` when the input does not fit; nothing changed. */
export class EditorDocumentLoadError extends Error {
  /** The `LoadReport` when the input was a file that could not be migrated. */
  readonly report?: LoadReport;

  constructor(message: string, report?: LoadReport) {
    super(message);
    this.name = "EditorDocumentLoadError";
    this.report = report;
  }
}

/** Marker of a saved editor document file (`EditorDocumentFile.format`). */
export const EDITOR_DOCUMENT_FORMAT = "pixerate.editor-document";

/** A document as it is saved: names its editor and format version. */
export interface EditorDocumentFile<T = unknown> {
  format: typeof EDITOR_DOCUMENT_FORMAT;
  kind: string;
  formatVersion: number;
  /** Display name, when it has one. */
  name?: string;
  document: T;
}

const KIND = /^[a-z][a-z0-9_]*$/;

export function isEditorDocumentFile(value: unknown): value is EditorDocumentFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.format === EDITOR_DOCUMENT_FORMAT && typeof v.kind === "string" && typeof v.formatVersion === "number" && "document" in v;
}

/** The current document wrapped as a file (what autosave and the save tools store). */
export function toEditorDocumentFile<T>(doc: EditorDocument<T>, name?: string): EditorDocumentFile<T> {
  return {
    format: EDITOR_DOCUMENT_FORMAT,
    kind: doc.kind,
    formatVersion: doc.formatVersion,
    ...(name ? { name } : {}),
    document: doc.getDocument(),
  };
}

/** JSON text of the current document as a file. */
export function serializeEditorDocument(doc: EditorDocument, options: { name?: string; space?: number } = {}): string {
  return JSON.stringify(toEditorDocumentFile(doc, options.name), null, options.space);
}

/**
 * Parses a file written by `serializeEditorDocument`. With `kind`, a file of
 * another editor is refused. Throws `EditorDocumentLoadError` with a message
 * that says what is wrong.
 */
export function parseEditorDocument<T = unknown>(text: string, options: { kind?: string } = {}): EditorDocumentFile<T> {
  let value: unknown;
  try {
    value = stripPrototypeKeys(JSON.parse(text));
  } catch (error) {
    throw new EditorDocumentLoadError(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isEditorDocumentFile(value)) {
    throw new EditorDocumentLoadError(`The file is not a saved editor document (expected "format": "${EDITOR_DOCUMENT_FORMAT}").`);
  }
  if (options.kind && value.kind !== options.kind) {
    throw new EditorDocumentLoadError(`The file is a ${value.kind} document, not a ${options.kind} document.`);
  }
  return value as EditorDocumentFile<T>;
}

/** What an editor supplies to `defineEditorDocument`. */
export interface EditorDocumentSpec<T> {
  kind: string;
  /** Default 1. */
  formatVersion?: number;
  /** Default `true`: `load` honours `history: "record"`. */
  recordsLoads?: boolean;
  get(): T;
  /**
   * Replaces the document. Throw (with a message saying what is wrong) before
   * changing anything when `document` does not fit. Return `problems` for parts
   * that were repaired with defaults (they land in the `LoadReport`).
   */
  load(document: unknown, options: { history: "reset" | "record" }): void | { problems?: SectionProblem[] };
  /** Calls `listener` after each document change (not selection or view changes). */
  subscribe(listener: () => void): () => void;
  history: EditorDocumentHistory;
  /** Why the document cannot be changed, or `false` (default: never read-only). */
  readOnly?: () => string | false;
  /** `migrations[v]` turns a version `v` document into version `v + 1`. */
  migrations?: Record<number, (document: unknown) => unknown>;
}

/**
 * Builds an `EditorDocument` from an editor's own methods: counts revisions,
 * unwraps and migrates files, and turns load failures into
 * `EditorDocumentLoadError`.
 */
export function defineEditorDocument<T>(spec: EditorDocumentSpec<T>): EditorDocument<T> {
  if (!KIND.test(spec.kind)) throw new Error(`Editor document kind "${spec.kind}" must match ${KIND}.`);
  const formatVersion = spec.formatVersion ?? 1;
  const listeners = new Set<() => void>();
  let revision = 0;
  let unsubscribe: (() => void) | null = null;
  let connected = false;
  const connect = () => {
    if (unsubscribe) return;
    // Changes made while disconnected were not counted, so a reconnect is a new revision.
    if (connected) revision++;
    connected = true;
    unsubscribe = spec.subscribe(() => {
      revision++;
      listeners.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          console.error(`[${spec.kind} document] Error in change listener:`, error);
        }
      });
    });
  };
  connect();

  const unwrap = (input: unknown): { document: unknown; report: LoadReport } => {
    if (!isEditorDocumentFile(input)) return { document: input, report: createLoadReport({ version: formatVersion }) };
    if (input.kind !== spec.kind) throw new EditorDocumentLoadError(`This is a ${input.kind} document; it cannot be opened in the ${spec.kind} editor.`);
    const steps = Object.fromEntries(
      Object.entries(spec.migrations ?? {}).map(([v, step]) => [v, (w: JsonObject) => ({ ...w, document: step(w.document) })]),
    );
    const { doc, report } = migrateDocument(
      { formatVersion: input.formatVersion, document: input.document },
      { currentVersion: formatVersion, versionKey: "formatVersion", steps },
    );
    if (report.readOnly) throw new EditorDocumentLoadError(`Cannot open the ${spec.kind} document: ${report.readOnly.message}.`, report);
    return { document: doc.document, report };
  };

  return {
    kind: spec.kind,
    formatVersion,
    recordsLoads: spec.recordsLoads !== false,
    getDocument: () => spec.get(),
    loadDocument(input, options = {}) {
      const { document, report } = unwrap(input);
      if (document === undefined || document === null) throw new EditorDocumentLoadError(`No ${spec.kind} document was given.`);
      try {
        const result = spec.load(document, { history: options.history ?? "reset" });
        if (result?.problems?.length) report.problems.push(...result.problems);
      } catch (error) {
        if (error instanceof EditorDocumentLoadError) throw error;
        throw new EditorDocumentLoadError(error instanceof Error ? error.message : String(error));
      }
      return report;
    },
    revision: () => {
      connect();
      return revision;
    },
    subscribe(listener) {
      connect();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    history: spec.history,
    readOnly: () => spec.readOnly?.() ?? false,
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
