/**
 * `spreadsheet` import adapters for the import registry: CSV and TSV files
 * parsed with the RFC 4180 parser in `csv.ts`.
 *
 * They are not registered by default (the default registry only knows
 * `document` adapters). Registries are passed in explicitly so this entry
 * point does not pull in the document adapters (markdown, TipTap):
 *
 *   registerSpreadsheetImportAdapters(defaultImportRegistry);
 *   await importFileIntoSpreadsheet(controller, file, { registry: defaultImportRegistry });
 */
import type {
  ImportAdapter,
  ImportAdapterRegistry,
  ImportInput,
  ImportOutcome,
} from '../import/registry';
import type { SpreadsheetController } from './controller';
import { parseCsv } from './csv';

/** Result of every `spreadsheet` adapter. */
export interface SpreadsheetImport {
  /** Parsed records, one array of raw cell inputs per row. */
  rows: string[][];
  /** Field separator the file was parsed with. */
  delimiter: string;
}

export type SpreadsheetImportAdapter = ImportAdapter<SpreadsheetImport>;

function delimitedAdapter(
  id: string,
  label: string,
  delimiter: string,
  mimeTypes: string[],
  extensions: string[],
): SpreadsheetImportAdapter {
  return {
    id,
    label,
    mimeTypes,
    extensions,
    target: 'spreadsheet',
    async import(_input, context) {
      return { rows: parseCsv(await context.readText(), { delimiter }), delimiter };
    },
  };
}

export const csvImportAdapter = delimitedAdapter(
  'csv',
  'CSV',
  ',',
  ['text/csv', 'application/csv', 'text/comma-separated-values'],
  ['.csv'],
);

export const tsvImportAdapter = delimitedAdapter(
  'tsv',
  'Tab-separated values',
  '\t',
  ['text/tab-separated-values'],
  ['.tsv', '.tab'],
);

export const SPREADSHEET_IMPORT_ADAPTERS: readonly SpreadsheetImportAdapter[] = [
  csvImportAdapter,
  tsvImportAdapter,
];

/** Registers the CSV and TSV adapters; returns a function that unregisters them. */
export function registerSpreadsheetImportAdapters(registry: ImportAdapterRegistry): () => void {
  const unregisters = SPREADSHEET_IMPORT_ADAPTERS.map((adapter) =>
    registry.register(adapter, { replace: true }),
  );
  return () => unregisters.forEach((unregister) => unregister());
}

export interface ImportFileIntoSpreadsheetOptions {
  /** Registry to resolve the adapter from (e.g. `defaultImportRegistry`). */
  registry: ImportAdapterRegistry;
  /** Force an adapter instead of matching by file name / MIME type. */
  adapterId?: string;
  fileName?: string;
  mimeType?: string;
  /** Top-left cell to write to (0-based). Default A1. */
  startRow?: number;
  startCol?: number;
}

/**
 * Imports a CSV/TSV file (or any registered `spreadsheet` adapter that
 * returns `SpreadsheetImport`) into the controller as one undoable change.
 */
export async function importFileIntoSpreadsheet(
  controller: SpreadsheetController,
  input: ImportInput,
  options: ImportFileIntoSpreadsheetOptions,
): Promise<ImportOutcome<SpreadsheetImport>> {
  const { registry, startRow, startCol, ...rest } = options;
  const outcome = await registry.importFile<SpreadsheetImport>(input, { ...rest, target: 'spreadsheet' });
  controller.importRows(outcome.result.rows, { startRow, startCol });
  return outcome;
}
