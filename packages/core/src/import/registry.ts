/**
 * Import adapter registry: maps file types (MIME types and extensions) to
 * converters that turn a file into editor content. Modelled on the desktop
 * import pipelines of document apps, where each source format declares the
 * MIME types and extensions it accepts.
 *
 * Built-in adapters cover markdown, HTML, plain text, RTF and DOCX for the
 * `document` target. PDF (`createPdfImportAdapter`), zipped exports
 * (`zipImportAdapter`) and other targets (e.g. CSV → `spreadsheet`) plug in
 * with `registerImportAdapter`.
 */

/** What an import produces content for. Custom targets are plain strings. */
export type ImportTarget = "document" | "spreadsheet" | (string & {});

/** A `File`/`Blob`-like object; only the members present are used. */
export interface FileLike {
  name?: string;
  type?: string;
  size?: number;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Anything an adapter can import: raw text, binary data, or a file. */
export type ImportInput = string | ArrayBuffer | ArrayBufferView | FileLike;

/** Helpers passed to adapters so they don't each re-implement decoding. */
export interface ImportContext {
  fileName?: string;
  mimeType?: string;
  target: ImportTarget;
  /** Reads the input as UTF-8 text (a leading byte-order mark is removed). */
  readText(): Promise<string>;
  /** Reads the input as binary data (strings are UTF-8 encoded). */
  readArrayBuffer(): Promise<ArrayBuffer>;
  /**
   * The registry running the import, so container adapters (e.g. zipped
   * exports) can import nested files with the same adapters.
   */
  registry?: ImportAdapterRegistry;
  /**
   * Per-import options for this adapter: `ImportFileOptions.adapterOptions[adapter.id]`.
   * Adapters document what they accept (e.g. the PDF adapter's `{ structure: false }`).
   */
  options?: unknown;
}

export interface ImportAdapter<TResult = unknown> {
  /** Unique id, e.g. `markdown`, `html`, `csv`. */
  id: string;
  /** Human-readable name for menus, e.g. "Markdown". */
  label: string;
  /** Accepted MIME types; `type/*` wildcards are allowed. */
  mimeTypes: readonly string[];
  /** Accepted extensions with a leading dot; multi-part ones (`.md.txt`) are allowed. */
  extensions: readonly string[];
  target: ImportTarget;
  /** Tie-breaker between equally specific matches (default 0, higher wins). */
  priority?: number;
  import(input: ImportInput, context: ImportContext): Promise<TResult> | TResult;
}

export interface FindImportAdapterQuery {
  mimeType?: string;
  fileName?: string;
  /** Only consider adapters for this target. */
  target?: ImportTarget;
}

export interface ImportFileOptions {
  /** Only consider adapters for this target. */
  target?: ImportTarget;
  /** Use this adapter instead of matching by type. */
  adapterId?: string;
  /** Overrides the input's own `name` (required to match string/binary input by extension). */
  fileName?: string;
  /** Overrides the input's own `type`. */
  mimeType?: string;
  /**
   * Options for individual adapters, keyed by adapter id; the matching entry
   * reaches the adapter as `context.options`. Example: `{ pdf: { structure: false } }`.
   */
  adapterOptions?: Record<string, unknown>;
}

export interface ImportOutcome<TResult = unknown> {
  adapterId: string;
  target: ImportTarget;
  fileName?: string;
  mimeType?: string;
  result: TResult;
}

export type ImportErrorCode =
  | "unsupported_type"
  | "unknown_adapter"
  | "adapter_failed"
  /** The file is damaged or not the format its name/type claims (e.g. a `.docx` without `word/document.xml`). */
  | "invalid_file"
  /** A platform API the adapter needs (e.g. `DOMParser`) is missing. */
  | "unsupported_environment";

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly fileName?: string;

  constructor(code: ImportErrorCode, message: string, details: { fileName?: string; cause?: unknown } = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ImportError";
    this.code = code;
    this.fileName = details.fileName;
  }
}

export interface RegisterImportAdapterOptions {
  /** Replace an adapter with the same id instead of throwing. */
  replace?: boolean;
}

const normalizeExtension = (ext: string) => {
  const lower = ext.trim().toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
};

const normalizeMimeType = (mime: string | undefined) =>
  (mime ?? "").split(";")[0].trim().toLowerCase();

function isFileLike(input: ImportInput): input is FileLike {
  return (
    typeof input === "object" &&
    input !== null &&
    !(input instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(input)
  );
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Creates the {@link ImportContext} helpers for an input. */
export function createImportContext(
  input: ImportInput,
  details: { fileName?: string; mimeType?: string; target: ImportTarget; registry?: ImportAdapterRegistry; options?: unknown },
): ImportContext {
  const readArrayBuffer = async (): Promise<ArrayBuffer> => {
    if (typeof input === "string") {
      return new TextEncoder().encode(input).buffer as ArrayBuffer;
    }
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
    }
    if (typeof input.arrayBuffer === "function") return input.arrayBuffer();
    if (typeof input.text === "function") {
      return new TextEncoder().encode(await input.text()).buffer as ArrayBuffer;
    }
    throw new TypeError("Import input cannot be read as binary data.");
  };
  const readText = async (): Promise<string> => {
    if (typeof input === "string") return stripBom(input);
    if (isFileLike(input) && typeof input.text === "function") {
      return stripBom(await input.text());
    }
    return stripBom(new TextDecoder("utf-8").decode(await readArrayBuffer()));
  };
  return { ...details, readText, readArrayBuffer };
}

/**
 * A set of import adapters with type matching. Use the default registry via
 * the module-level helpers (`registerImportAdapter`, `importFile`, …) or
 * create isolated ones with `createImportAdapterRegistry`.
 */
export class ImportAdapterRegistry {
  private adapters: ImportAdapter<any>[] = [];

  /** Registers an adapter and returns a function that unregisters it. */
  register<TResult>(adapter: ImportAdapter<TResult>, options: RegisterImportAdapterOptions = {}): () => void {
    const existing = this.adapters.findIndex((a) => a.id === adapter.id);
    if (existing !== -1) {
      if (!options.replace) {
        throw new Error(`Import adapter "${adapter.id}" is already registered.`);
      }
      this.adapters.splice(existing, 1);
    }
    this.adapters.push(adapter);
    return () => {
      this.unregister(adapter);
    };
  }

  /** Removes an adapter by id or instance. Returns whether it was registered. */
  unregister(adapterOrId: string | ImportAdapter<any>): boolean {
    const index = this.adapters.findIndex((a) =>
      typeof adapterOrId === "string" ? a.id === adapterOrId : a === adapterOrId,
    );
    if (index === -1) return false;
    this.adapters.splice(index, 1);
    return true;
  }

  get(id: string): ImportAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  /** Registered adapters in registration order, optionally for one target. */
  list(target?: ImportTarget): ImportAdapter[] {
    return this.adapters.filter((a) => target === undefined || a.target === target);
  }

  /**
   * Finds the best adapter for a file. Extensions win over MIME types (browsers
   * often report `""` or `text/plain` for markdown), the longest matching
   * extension wins (`.md.txt` beats `.txt`), exact MIME types beat `type/*`
   * wildcards, then higher `priority`, then the most recently registered.
   */
  find(query: FindImportAdapterQuery): ImportAdapter | undefined {
    const fileName = query.fileName?.toLowerCase() ?? "";
    const mime = normalizeMimeType(query.mimeType);
    let best: ImportAdapter | undefined;
    let bestScore = 0;
    let bestPriority = -Infinity;
    this.adapters.forEach((adapter) => {
      if (query.target !== undefined && adapter.target !== query.target) return;
      let score = 0;
      if (fileName) {
        for (const raw of adapter.extensions) {
          const ext = normalizeExtension(raw);
          if (fileName.endsWith(ext) && fileName.length > ext.length) {
            // Extension matches always outrank MIME matches.
            score = Math.max(score, 1000 + ext.length);
          }
        }
      }
      if (score === 0 && mime) {
        for (const raw of adapter.mimeTypes) {
          const accepted = normalizeMimeType(raw);
          if (accepted === mime) score = Math.max(score, 2);
          else if (accepted.endsWith("/*") && mime.startsWith(accepted.slice(0, -1))) {
            score = Math.max(score, 1);
          }
        }
      }
      if (score === 0) return;
      const priority = adapter.priority ?? 0;
      // `>=` so later registrations win ties and can override built-ins.
      if (score > bestScore || (score === bestScore && priority >= bestPriority)) {
        best = adapter;
        bestScore = score;
        bestPriority = priority;
      }
    });
    return best;
  }

  /**
   * Returns a value for `<input type="file" accept="…">` covering every
   * registered extension and MIME type (optionally for one target).
   */
  accept(target?: ImportTarget): string {
    const values = new Set<string>();
    for (const adapter of this.list(target)) {
      adapter.extensions.forEach((ext) => values.add(normalizeExtension(ext)));
      adapter.mimeTypes.forEach((mime) => values.add(normalizeMimeType(mime)));
    }
    return Array.from(values).join(",");
  }

  /** Whether some adapter (optionally for `target`) accepts this file. */
  canImport(file: { name?: string; type?: string }, target?: ImportTarget): boolean {
    return !!this.find({ fileName: file.name, mimeType: file.type, target });
  }

  /**
   * Imports a file (or string / binary input) with the matching adapter.
   * Rejects with an {@link ImportError} when no adapter matches or the
   * adapter fails.
   */
  async importFile<TResult = unknown>(input: ImportInput, options: ImportFileOptions = {}): Promise<ImportOutcome<TResult>> {
    const fileName = options.fileName ?? (isFileLike(input) ? input.name : undefined);
    const mimeType = options.mimeType ?? (isFileLike(input) ? input.type : undefined);
    let adapter: ImportAdapter | undefined;
    if (options.adapterId) {
      adapter = this.get(options.adapterId);
      if (!adapter) {
        throw new ImportError("unknown_adapter", `No import adapter with id "${options.adapterId}".`, { fileName });
      }
    } else {
      adapter = this.find({ fileName, mimeType, target: options.target });
    }
    if (!adapter) {
      const what = fileName || mimeType || "input";
      throw new ImportError(
        "unsupported_type",
        `No import adapter accepts ${what}${options.target ? ` for target "${options.target}"` : ""}.`,
        { fileName },
      );
    }
    const context = createImportContext(input, {
      fileName,
      mimeType,
      target: adapter.target,
      registry: this,
      options: options.adapterOptions?.[adapter.id],
    });
    try {
      const result = (await adapter.import(input, context)) as TResult;
      return { adapterId: adapter.id, target: adapter.target, fileName, mimeType, result };
    } catch (error) {
      // Adapters may throw structured ImportErrors (e.g. `invalid_file`); keep their code.
      if (error instanceof ImportError) {
        if (error.fileName !== undefined || fileName === undefined) throw error;
        throw new ImportError(error.code, error.message, { fileName, cause: error.cause });
      }
      throw new ImportError(
        "adapter_failed",
        `Import adapter "${adapter.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { fileName, cause: error },
      );
    }
  }
}
