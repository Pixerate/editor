import {
  exportDocxBlob,
  type DocxExportEditorLike,
  type DocxExportOptions,
  type DocxExportReport,
  type DocxJSONNode,
} from "./docx";

/**
 * Saves a `Blob` as a file through a temporary `<a download>` link. Does
 * nothing (returns `false`) without a DOM.
 */
export function downloadBlob(blob: Blob, fileName: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return false;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled, or some browsers cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/** `name.docx`, with characters that are invalid in file names replaced. */
export function docxFileName(name: string | undefined): string {
  const base = (name ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.docx$/i, "")
    .slice(0, 120);
  return `${base || "document"}.docx`;
}

export interface DocxExportState {
  isExporting: boolean;
  /** Last export error (cleared when a new export starts). */
  error: Error | null;
  /** Report of the most recent successful export. */
  lastReport: DocxExportReport | null;
}

export interface DocxExportControllerOptions extends DocxExportOptions {
  /** Download file name (default: `title`, else `document`, plus `.docx`). */
  fileName?: string;
  /** Called after each successful export with its report. */
  onExport?: (report: DocxExportReport, blob: Blob) => void;
  /** Called when an export fails (the error is also kept in the state). */
  onError?: (error: Error) => void;
}

/**
 * Framework-agnostic state for an "Export to Word" button: tracks
 * `isExporting` / `error` / `lastReport` and downloads the `.docx` of the
 * editor returned by `getSource`. React's `useDocxExport` and Svelte's
 * `createDocxExport` wrap it.
 */
export class DocxExportController {
  private state: DocxExportState = { isExporting: false, error: null, lastReport: null };
  private readonly listeners = new Set<(state: DocxExportState) => void>();
  private pending = 0;

  constructor(
    private readonly getSource: () => DocxExportEditorLike | DocxJSONNode | null | undefined,
    private options: DocxExportControllerOptions = {},
  ) {}

  setOptions(options: DocxExportControllerOptions): void {
    this.options = options;
  }

  getState = (): DocxExportState => this.state;

  subscribe = (listener: (state: DocxExportState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<DocxExportState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  /** Builds the `.docx` without downloading it. Resolves with `null` when there is no editor or it fails. */
  async exportBlob(): Promise<{ blob: Blob; report: DocxExportReport } | null> {
    const source = this.getSource();
    if (!source) return null;
    this.pending++;
    this.setState({ isExporting: true, error: null });
    try {
      const { fileName: _fileName, onExport: _onExport, onError: _onError, ...exportOptions } = this.options;
      const result = await exportDocxBlob(source, exportOptions);
      this.setState({ lastReport: result.report });
      this.options.onExport?.(result.report, result.blob);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setState({ error: err });
      if (this.options.onError) this.options.onError(err);
      else console.error("[Editor] DOCX export failed:", err);
      return null;
    } finally {
      this.pending--;
      if (this.pending === 0) this.setState({ isExporting: false });
    }
  }

  /** Exports and downloads the document. Resolves with the report, or `null`. */
  async download(fileName?: string): Promise<DocxExportReport | null> {
    const result = await this.exportBlob();
    if (!result) return null;
    downloadBlob(result.blob, docxFileName(fileName ?? this.options.fileName ?? this.options.title));
    return result.report;
  }
}

export function createDocxExportController(
  getSource: () => DocxExportEditorLike | DocxJSONNode | null | undefined,
  options?: DocxExportControllerOptions,
): DocxExportController {
  return new DocxExportController(getSource, options);
}
