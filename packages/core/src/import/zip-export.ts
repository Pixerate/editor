import { escapeHtml } from "../serializers/plain-text";
import { defaultImportRegistry, type DocumentImport, type DocumentImportAdapter } from "./adapters";
import { ImportError, type ImportAdapterRegistry } from "./registry";
import { readZip, type ZipReadOptions } from "./zip";

/**
 * Zipped document exports (Notion, Confluence, Obsidian, static-site dumps):
 * a `.zip` of markdown / HTML / text / DOCX files. Each entry is imported
 * with the registry's other `document` adapters and the results are
 * concatenated, with a heading per file.
 *
 * Not registered by default: `.zip` is a generic container, and claiming
 * every dropped archive as a document would steal drops from other handlers
 * (e.g. attachment uploads). Opt in with
 * `registerImportAdapter(zipImportAdapter)`.
 */

export interface ZipDocumentImport extends DocumentImport {
  /** Imported entries in document order, with the adapter that handled each. */
  files: { name: string; adapterId: string }[];
  /** Entries that were left out, with the reason. */
  skipped: { name: string; reason: string }[];
}

export interface ZipImportOptions {
  /** Adapter id (default `"zip"`). */
  id?: string;
  /**
   * Registry used for the entries. Defaults to the registry running the
   * import (`context.registry`), then the default registry.
   */
  registry?: ImportAdapterRegistry;
  /** Add a heading with each file's title before its content (default `true`). */
  headings?: boolean;
  /** Heading level for file titles (default `2`). */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Import at most this many files (default 500); the rest are reported as skipped. */
  maxFiles?: number;
  /** Archive limits (default: 100 MiB extracted, 5 000 entries). */
  zip?: ZipReadOptions;
}

const INDEX_NAMES = /^(index|readme|home|_index|start)$/i;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (name: string) => name.replace(/\.[^./]+$/, "");

/** File title: the name without extension, path or a trailing Notion-style id. */
export function zipEntryTitle(path: string): string {
  const title = stem(baseName(path))
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  return title || baseName(path);
}

/**
 * Orders entries for import: index / README files first (shallowest first),
 * then by path with natural number ordering (`2` before `10`).
 */
export function sortZipEntryNames(names: readonly string[]): string[] {
  const isIndex = (name: string) => INDEX_NAMES.test(stem(baseName(name)));
  const depth = (name: string) => name.split("/").length;
  return [...names].sort((a, b) => {
    const ai = isIndex(a);
    const bi = isIndex(b);
    if (ai !== bi) return ai ? -1 : 1;
    if (ai && bi && depth(a) !== depth(b)) return depth(a) - depth(b);
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

const isJunk = (name: string) =>
  name.startsWith("__MACOSX/") || name.split("/").some((segment) => segment.startsWith("."));

/** Creates a `document` adapter for zipped exports. */
export function createZipImportAdapter(options: ZipImportOptions = {}): DocumentImportAdapter {
  const id = options.id ?? "zip";
  return {
    id,
    label: "Zipped documents",
    mimeTypes: ["application/zip", "application/x-zip-compressed"],
    extensions: [".zip"],
    target: "document",
    async import(_input, context): Promise<ZipDocumentImport> {
      const registry = options.registry ?? context.registry ?? defaultImportRegistry;
      const zip = await readZip(await context.readArrayBuffer(), {
        maxTotalSize: 100 * 1024 * 1024,
        maxEntries: 5_000,
        ...options.zip,
      });
      const maxFiles = options.maxFiles ?? 500;
      const level = options.headingLevel ?? 2;
      const files: ZipDocumentImport["files"] = [];
      const skipped: ZipDocumentImport["skipped"] = [];
      let html = "";
      let text = "";

      const names = zip.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
      for (const name of sortZipEntryNames(names)) {
        if (isJunk(name)) continue;
        const adapter = registry.find({ fileName: name, target: "document" });
        if (!adapter) {
          skipped.push({ name, reason: "unsupported type" });
          continue;
        }
        if (adapter.id === id || adapter.extensions.some((ext) => ext.toLowerCase() === ".zip")) {
          skipped.push({ name, reason: "nested archive" });
          continue;
        }
        if (files.length >= maxFiles) {
          skipped.push({ name, reason: "file limit reached" });
          continue;
        }
        try {
          const outcome = await registry.importFile<DocumentImport>(await zip.read(name), {
            fileName: name,
            adapterId: adapter.id,
          });
          const title = zipEntryTitle(name);
          if (options.headings !== false) {
            html += `<h${level}>${escapeHtml(title)}</h${level}>`;
            text += `${text ? "\n" : ""}${title}\n`;
          } else if (text) {
            text += "\n";
          }
          html += outcome.result.html.trim();
          text += outcome.result.text;
          files.push({ name, adapterId: adapter.id });
        } catch (error) {
          // Archive-wide limits stop the whole import; other failures skip the entry.
          const code = (error as { code?: string })?.code;
          if (code === "too_large") throw error;
          skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!files.length) {
        throw new ImportError("invalid_file", "The archive contains no importable documents.", {
          fileName: context.fileName,
        });
      }
      return { html, text, files, skipped };
    },
  };
}

/** Zipped-export adapter with default options. Opt in with `registerImportAdapter(zipImportAdapter)`. */
export const zipImportAdapter: DocumentImportAdapter = createZipImportAdapter();
