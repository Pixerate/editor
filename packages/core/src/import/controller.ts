import { defaultImportRegistry, type DocumentImport } from "./adapters";
import {
  importFilesIntoEditor,
  type ImportEditorTarget,
  type ImportFilesIntoEditorOptions,
} from "./editor";
import type { FileLike, ImportOutcome } from "./registry";
import type { ImportStructureReport } from "./pdf-layout";

/**
 * Opens the browser file picker and resolves with the chosen files (an empty
 * array when the dialog is cancelled). `accept` defaults to every extension
 * and MIME type the default registry can import as a document.
 */
export function pickImportFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  if (typeof document === "undefined") return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept ?? defaultImportRegistry.accept("document");
    input.multiple = options.multiple ?? true;
    input.style.display = "none";
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export interface FileImportState {
  isImporting: boolean;
  /** Last import error (cleared when a new import starts). */
  error: Error | null;
  /** Outcomes of the most recent import. */
  lastOutcomes: ImportOutcome<DocumentImport>[];
}

export interface FileImportControllerOptions extends Omit<ImportFilesIntoEditorOptions, "at"> {
  /** Allow choosing several files in the picker (default `true`). */
  multiple?: boolean;
}

/**
 * Framework-agnostic state for a file-import button: tracks `isImporting` /
 * `error`, opens the file picker and inserts the imported content into the
 * editor returned by `getTarget`. React's `useFileImport` and Svelte's
 * `createFileImport` wrap it.
 */
export class FileImportController {
  private state: FileImportState = { isImporting: false, error: null, lastOutcomes: [] };
  private readonly listeners = new Set<(state: FileImportState) => void>();
  private pending = 0;

  constructor(
    private readonly getTarget: () => ImportEditorTarget | null | undefined,
    private options: FileImportControllerOptions = {},
  ) {}

  setOptions(options: FileImportControllerOptions): void {
    this.options = options;
  }

  /** `accept` attribute value for document imports. */
  get accept(): string {
    return (this.options.registry ?? defaultImportRegistry).accept("document");
  }

  getState = (): FileImportState => this.state;

  subscribe = (listener: (state: FileImportState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<FileImportState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  /** Imports files into the editor at `at` (default: the selection). */
  importFiles = async (
    files: Iterable<FileLike> | ArrayLike<FileLike>,
    at?: number,
  ): Promise<ImportOutcome<DocumentImport>[]> => {
    const target = this.getTarget();
    const list = Array.from(files as ArrayLike<FileLike>);
    if (!target || list.length === 0) return [];
    this.pending++;
    this.setState({ isImporting: true, error: null });
    let error: Error | null = null;
    try {
      const outcomes = await importFilesIntoEditor(target, list, {
        ...this.options,
        at,
        onError: (err, file) => {
          error = err;
          this.options.onError?.(err, file);
        },
      });
      this.pending--;
      this.setState({ isImporting: this.pending > 0, error, lastOutcomes: outcomes });
      return outcomes;
    } catch (err) {
      this.pending--;
      this.setState({ isImporting: this.pending > 0, error: err instanceof Error ? err : new Error(String(err)) });
      return [];
    }
  };

  /** Opens the file picker and imports the chosen files at the selection. */
  openFilePicker = async (): Promise<ImportOutcome<DocumentImport>[]> => {
    const files = await pickImportFiles({ accept: this.accept, multiple: this.options.multiple });
    return this.importFiles(files);
  };
}

export function createFileImportController(
  getTarget: () => ImportEditorTarget | null | undefined,
  options?: FileImportControllerOptions,
): FileImportController {
  return new FileImportController(getTarget, options);
}

/** Totals of the structure reports (`DocumentImport.structure`) of several imports. */
export interface ImportStructureSummary {
  /** Imports that carried a report. */
  files: number;
  /** `"mixed"` when some files were imported with structure detection and some without. */
  mode: "structured" | "plain" | "mixed";
  headings: number;
  lists: number;
  tables: number;
  paragraphs: number;
  multiColumnPages: number;
  /** Mean of the reports' confidences (0–1). */
  confidence: number;
}

/**
 * Sums the structure reports of import outcomes, e.g. `lastOutcomes` from a
 * file-import controller. Returns `null` when no outcome has a report (only
 * structure-aware adapters such as PDF produce one).
 */
export function summarizeImportStructure(
  outcomes: readonly ImportOutcome<DocumentImport>[],
): ImportStructureSummary | null {
  const reports = outcomes
    .map((outcome) => outcome.result?.structure)
    .filter((report): report is ImportStructureReport => !!report);
  if (!reports.length) return null;
  const modes = new Set(reports.map((report) => report.mode));
  const sum = (pick: (report: ImportStructureReport) => number) =>
    reports.reduce((total, report) => total + pick(report), 0);
  return {
    files: reports.length,
    mode: modes.size > 1 ? "mixed" : reports[0].mode,
    headings: sum((r) => r.counts.headings),
    lists: sum((r) => r.counts.lists),
    tables: sum((r) => r.counts.tables),
    paragraphs: sum((r) => r.counts.paragraphs),
    multiColumnPages: sum((r) => r.multiColumnPages),
    confidence: Math.round((sum((r) => r.confidence) / reports.length) * 100) / 100,
  };
}
