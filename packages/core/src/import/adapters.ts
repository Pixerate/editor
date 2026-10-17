import type { ChartSpec } from "../chart/types";
import { markdownToTipTapHtml } from "../serializers/markdown";
import { htmlToPlainText } from "../serializers/plain-text";
import { plainTextToParagraphHtml, sanitizeImportedHtml } from "../serializers/html";
import { rtfToPlainText } from "../serializers/rtf";
import { docxImportAdapter } from "./docx";
import type { ImportStructureReport } from "./pdf-layout";
import type { SerializedComments } from "../extensions/comment-store";
import type { StyleRegistry } from "../extensions/paragraph-styles/registry";
import {
  ImportAdapterRegistry,
  type FindImportAdapterQuery,
  type ImportAdapter,
  type ImportFileOptions,
  type ImportInput,
  type ImportOutcome,
  type ImportTarget,
  type RegisterImportAdapterOptions,
} from "./registry";

/** Result of every `document` adapter: sanitized TipTap HTML plus plain text. */
export interface DocumentImport {
  /** Sanitized HTML ready for `setContent` / `insertContent`. */
  html: string;
  /** Plain-text version, used by plain-text (prompt) editors. */
  text: string;
  /**
   * What a structure-aware importer recognised (headings, lists, tables,
   * columns) with confidences; set by the PDF adapter.
   */
  structure?: ImportStructureReport;
  /**
   * Comment threads (with replies and resolved state) whose ranges the HTML
   * marks with `data-comment-id`; set by the DOCX adapter. Load them into the
   * editor's comment store, e.g. with `applyImportedReviewData`.
   */
  comments?: SerializedComments;
  /** Paragraph and character styles the file defines; set by the DOCX adapter. */
  styles?: StyleRegistry;
  /**
   * Charts embedded in the file (DOCX), in document order. The HTML shows each as a caption
   * and a table of its data; render `spec` with the chart editor for the real chart.
   */
  charts?: ImportedChart[];
}

/** A chart read from an imported file. */
export interface ImportedChart {
  /** `chart-1`, `chart-2`, … in document order. */
  id: string;
  /** The part it came from, e.g. `word/charts/chart1.xml`. */
  path: string;
  title: string;
  spec: ChartSpec;
  /** Problems reading it, as sentences. */
  issues: string[];
  /** Features the chart editor cannot hold (3-D, stock, …). */
  unsupported: string[];
  /** Writing `spec` back loses nothing. */
  lossless: boolean;
}

export type DocumentImportAdapter = ImportAdapter<DocumentImport>;

/**
 * Markdown files. Rendered with the same sanitizing pipeline as
 * `markdownToTipTapHtml`. `.txt` is deliberately left to the plain-text
 * adapter so ordinary text files are not reinterpreted as markdown; `.md.txt`
 * still matches here because the longest extension wins.
 */
export const markdownImportAdapter: DocumentImportAdapter = {
  id: "markdown",
  label: "Markdown",
  mimeTypes: ["text/markdown", "text/x-markdown"],
  extensions: [".md", ".mdown", ".markdown", ".mkdn", ".mkd", ".rmd", ".md.txt"],
  target: "document",
  async import(_input, context) {
    const text = await context.readText();
    return { html: markdownToTipTapHtml(text), text };
  },
};

/** HTML files and fragments, sanitized with `sanitizeImportedHtml`. */
export const htmlImportAdapter: DocumentImportAdapter = {
  id: "html",
  label: "HTML",
  mimeTypes: ["text/html", "application/xhtml+xml"],
  extensions: [".html", ".htm", ".xhtml"],
  target: "document",
  async import(_input, context) {
    const html = sanitizeImportedHtml(await context.readText());
    return { html, text: htmlToPlainText(html) };
  },
};

/** Plain text: one paragraph per line, always escaped. */
export const plainTextImportAdapter: DocumentImportAdapter = {
  id: "text",
  label: "Plain text",
  mimeTypes: ["text/plain"],
  extensions: [".txt", ".text"],
  target: "document",
  async import(_input, context) {
    const text = (await context.readText()).replace(/\r\n?/g, "\n");
    return { html: plainTextToParagraphHtml(text), text };
  },
};

/**
 * RTF: best-effort text extraction with `rtfToPlainText` (paragraphs and
 * characters only; formatting, tables and images are dropped).
 */
export const rtfImportAdapter: DocumentImportAdapter = {
  id: "rtf",
  label: "Rich Text Format",
  mimeTypes: ["application/rtf", "text/rtf"],
  extensions: [".rtf"],
  target: "document",
  async import(_input, context) {
    const text = rtfToPlainText(await context.readText());
    return { html: plainTextToParagraphHtml(text), text };
  },
};

export const BUILT_IN_IMPORT_ADAPTERS: readonly DocumentImportAdapter[] = [
  markdownImportAdapter,
  htmlImportAdapter,
  plainTextImportAdapter,
  rtfImportAdapter,
  docxImportAdapter,
];

export interface CreateImportAdapterRegistryOptions {
  /** Register the built-in document adapters (default `true`). */
  builtIns?: boolean;
}

export function createImportAdapterRegistry(
  options: CreateImportAdapterRegistryOptions = {},
): ImportAdapterRegistry {
  const registry = new ImportAdapterRegistry();
  if (options.builtIns !== false) {
    BUILT_IN_IMPORT_ADAPTERS.forEach((adapter) => registry.register(adapter));
  }
  return registry;
}

/** Shared registry used by the module-level helpers and editor integrations. */
export const defaultImportRegistry = createImportAdapterRegistry();

/** Registers an adapter on the default registry; returns an unregister function. */
export function registerImportAdapter<TResult>(
  adapter: ImportAdapter<TResult>,
  options?: RegisterImportAdapterOptions,
): () => void {
  return defaultImportRegistry.register(adapter, options);
}

export function unregisterImportAdapter(adapterOrId: string | ImportAdapter<any>): boolean {
  return defaultImportRegistry.unregister(adapterOrId);
}

export function findImportAdapter(query: FindImportAdapterQuery): ImportAdapter | undefined {
  return defaultImportRegistry.find(query);
}

/** Imports a file with the default registry. */
export function importFile<TResult = unknown>(
  input: ImportInput,
  options?: ImportFileOptions,
): Promise<ImportOutcome<TResult>> {
  return defaultImportRegistry.importFile<TResult>(input, options);
}

/** `accept` attribute value for the default registry. */
export function getImportAccept(target?: ImportTarget): string {
  return defaultImportRegistry.accept(target);
}
