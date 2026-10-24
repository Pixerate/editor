import type { AgentTool, AgentToolProvider } from "../tools/registry";
import type { JsonSchema } from "../tools/schema";
import type { EditorDocumentStore } from "./documentStore";
import type { EditorDocument } from "./editorDocument";
import type { LoadReport } from "./migrate";

export interface DocumentToolProviderOptions {
  /** Provider id (default `<kind>-document`). */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the id, `''` for bare names. */
  namespace?: string;
  /** Toolset title (default "<Noun> document"). */
  title?: string;
  /** The skill that documents the editor's tools, e.g. `pixerate-diagram`. */
  skill?: string;
  /** What the document is called in descriptions (default the kind with spaces, e.g. "video project"). */
  noun?: string;
  /**
   * Add `undo_<kind>` / `redo_<kind>` (default `true`). Pass `false` for editors
   * whose own provider already has them.
   */
  history?: boolean;
  /** Saved documents: adds `save_<kind>_document`, `list_saved_<kind>_documents` and `open_saved_<kind>_document`. */
  store?: EditorDocumentStore;
  /** Name `save_<kind>_document` uses when none is given (default "Untitled <noun>"). */
  name?: () => string | undefined;
  /** `get_<kind>_document` refuses documents whose JSON is longer than this (default 200000 characters). */
  maxChars?: number;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const object = (properties: Record<string, JsonSchema>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const reportOut = (report: LoadReport) => ({
  ...(report.migratedFrom !== null ? { migratedFrom: report.migratedFrom } : {}),
  ...(report.problems.length ? { problems: report.problems } : {}),
  ...(report.unknownKeys.length ? { unknownKeys: report.unknownKeys } : {}),
});

/**
 * The same document tools for every editor, named after `doc.kind`:
 * `get_<kind>_document`, `load_<kind>_document`, `undo_<kind>`, `redo_<kind>`
 * and, with a `store`, `save_<kind>_document`, `list_saved_<kind>_documents`
 * and `open_saved_<kind>_document`. Loads are checked before anything changes
 * and are one undo step where the editor supports it. A read-only document
 * keeps its read tools; its write tools refuse with the reason.
 */
export function createDocumentToolProvider(doc: EditorDocument, options: DocumentToolProviderOptions = {}): AgentToolProvider {
  const { kind } = doc;
  const noun = options.noun ?? kind.replace(/_/g, " ");
  const maxChars = options.maxChars ?? 200_000;
  const store = options.store;
  const writable = () => {
    const reason = doc.readOnly();
    if (reason) throw new Error(`${reason} Read tools still work; write tools are refused.`);
  };
  const historyOut = () => {
    const h = doc.history.getState();
    return {
      revision: doc.revision(),
      canUndo: h.canUndo,
      canRedo: h.canRedo,
      ...(h.undoName ? { undoName: h.undoName } : {}),
      ...(h.redoName ? { redoName: h.redoName } : {}),
    };
  };
  const loaded = (report: LoadReport) => ({
    revision: doc.revision(),
    undoable: doc.recordsLoads,
    ...reportOut(report),
  });

  const get: AgentTool = {
    name: `get_${kind}_document`,
    title: `Get the ${noun} document`,
    description:
      `Returns the whole ${noun} as plain JSON: { kind, formatVersion, revision, document }. Use it to keep a copy, compare versions or pass the document to load_${kind}_document later. ` +
      `For reading or editing parts of the ${noun}, prefer the editor's own read tools: this result can be large.`,
    inputSchema: object({}),
    annotations: { title: `Get the ${noun} document`, ...READ },
    handler: () => {
      const document = doc.getDocument();
      const size = JSON.stringify(document)?.length ?? 0;
      if (size > maxChars) {
        throw new Error(`The ${noun} document is ${size} characters of JSON, over the ${maxChars} limit for this tool. Use the editor's read tools to look at parts of it.`);
      }
      return { kind, formatVersion: doc.formatVersion, revision: doc.revision(), document };
    },
  };

  const load: AgentTool = {
    name: `load_${kind}_document`,
    title: `Load a ${noun} document`,
    description:
      `Replaces the whole ${noun} with a document from get_${kind}_document (its "document" value, or the whole result as a saved file). ` +
      `The document is checked first: when it does not fit, nothing changes and the error says why. ` +
      `Returns { revision, undoable, migratedFrom?, problems?, unknownKeys? }; undoable: true means undo_${kind} brings the previous ${noun} back.`,
    inputSchema: object(
      {
        document: {
          type: "object",
          description: `The ${noun} document: the "document" value from get_${kind}_document, or a saved file ({ format, kind, formatVersion, document }).`,
        },
      },
      ["document"],
    ),
    annotations: { title: `Load a ${noun} document`, ...REPLACE },
    handler: ({ document }) => {
      writable();
      return loaded(doc.loadDocument(document, { history: "record" }));
    },
  };

  const undo: AgentTool = {
    name: `undo_${kind}`,
    title: `Undo a ${noun} edit`,
    description: `Undoes the last ${noun} edit (one tool call or one user gesture). Returns { undone, revision, canUndo, canRedo, undoName?, redoName? }; undone is the name of the step that was undone.`,
    inputSchema: object({}),
    annotations: { title: `Undo a ${noun} edit`, ...WRITE },
    handler: () => {
      writable();
      const name = doc.history.getState().undoName;
      if (!doc.history.getState().canUndo || !doc.history.undo()) throw new Error("Nothing to undo.");
      return { undone: name ?? true, ...historyOut() };
    },
  };

  const redo: AgentTool = {
    name: `redo_${kind}`,
    title: `Redo a ${noun} edit`,
    description: `Redoes the last undone ${noun} edit. Returns { redone, revision, canUndo, canRedo, undoName?, redoName? }; redone is the name of the step that was redone.`,
    inputSchema: object({}),
    annotations: { title: `Redo a ${noun} edit`, ...WRITE },
    handler: () => {
      writable();
      const name = doc.history.getState().redoName;
      if (!doc.history.getState().canRedo || !doc.history.redo()) throw new Error("Nothing to redo.");
      return { redone: name ?? true, ...historyOut() };
    },
  };

  const storeTools = (s: EditorDocumentStore): AgentTool[] => [
    {
      name: `save_${kind}_document`,
      title: `Save the ${noun}`,
      description:
        `Saves the current ${noun} under a name in the host's document storage. Saving the same name again replaces that saved copy. ` +
        `Returns { key, name, savedAt, revision }; pass key to open_saved_${kind}_document to load it again.`,
      inputSchema: object({
        name: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: `Name to save under (default: the ${noun}'s current name, or "Untitled ${noun}").`,
        },
      }),
      annotations: { title: `Save the ${noun}`, ...OVERWRITE },
      handler: async ({ name }) => {
        const entry = await s.save(doc, name ?? options.name?.() ?? `Untitled ${noun}`);
        return { key: entry.key, name: entry.name, savedAt: entry.savedAt, revision: doc.revision() };
      },
    },
    {
      name: `list_saved_${kind}_documents`,
      title: `List saved ${noun} documents`,
      description: `Lists the ${noun} documents in the host's document storage, newest first. Returns { documents: [{ key, name, savedAt, formatVersion }] }.`,
      inputSchema: object({}),
      annotations: { title: `List saved ${noun} documents`, ...READ },
      handler: async () => ({
        documents: (await s.list(kind)).map(({ key, name, savedAt, formatVersion }) => ({ key, name, savedAt, formatVersion })),
      }),
    },
    {
      name: `open_saved_${kind}_document`,
      title: `Open a saved ${noun}`,
      description:
        `Replaces the current ${noun} with a saved one. Unsaved changes stay reachable through undo_${kind} when undoable is true. ` +
        `Returns { key, name, revision, undoable, migratedFrom?, problems?, unknownKeys? }.`,
      inputSchema: object({ key: { type: "string", minLength: 1, description: `A key from list_saved_${kind}_documents or save_${kind}_document.` } }, ["key"]),
      annotations: { title: `Open a saved ${noun}`, ...REPLACE },
      handler: async ({ key }) => {
        writable();
        const entry = await s.open(doc, key, { history: "record" });
        return { key: entry.key, name: entry.name, ...loaded(entry.report) };
      },
    },
  ];

  return {
    id: options.id ?? `${kind}-document`,
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    title: options.title ?? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} document`,
    description: `Get, load${options.history === false ? "" : ", undo, redo"}${store ? ", save and open" : ""} the whole ${noun}.`,
    ...(options.skill ? { skill: options.skill } : {}),
    tools: [get, load, ...(options.history === false ? [] : [undo, redo]), ...(store ? storeTools(store) : [])],
  };
}
