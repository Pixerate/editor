import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument';
import type { SpreadsheetController } from './controller';
import type { SpreadsheetWorkbook } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function checkWorkbook(document: unknown): asserts document is SpreadsheetWorkbook {
  const hint = 'A spreadsheet document is a workbook { sheets: [{ columns, rows, cells }], activeSheetId?, names? } as get_spreadsheet_document returns it.';
  if (!isRecord(document) || !Array.isArray(document.sheets) || document.sheets.length === 0) throw new Error(`sheets must be a non-empty array. ${hint}`);
  document.sheets.forEach((sheet, i) => {
    if (!isRecord(sheet)) throw new Error(`sheets[${i}] must be an object. ${hint}`);
    if (!Array.isArray(sheet.columns)) throw new Error(`sheets[${i}].columns must be an array. ${hint}`);
    if (!Array.isArray(sheet.rows)) throw new Error(`sheets[${i}].rows must be an array. ${hint}`);
    if (!isRecord(sheet.cells)) throw new Error(`sheets[${i}].cells must be an object of rows. ${hint}`);
  });
  if (document.names !== undefined && !Array.isArray(document.names)) throw new Error(`names must be an array. ${hint}`);
}

/**
 * The save / load / undo contract for a `SpreadsheetController` (kind `spreadsheet`, document:
 * the whole workbook from `getWorkbook`: every sheet, the active sheet and the defined names).
 * Recorded loads are one undo step. Selection and editing state are not part of the document.
 */
export function createSpreadsheetEditorDocument(controller: SpreadsheetController): EditorDocument<SpreadsheetWorkbook> {
  return defineEditorDocument<SpreadsheetWorkbook>({
    kind: 'spreadsheet',
    get: () => controller.getWorkbook(),
    load: (document, { history }) => {
      checkWorkbook(document);
      controller.loadWorkbook(document, { undoable: history === 'record' });
    },
    subscribe: (listener) => controller.subscribe(listener),
    history: {
      undo: () => controller.undo(),
      redo: () => controller.redo(),
      getState: () => {
        const depth = controller.getHistoryDepth();
        return { canUndo: depth.undo > 0, canRedo: depth.redo > 0 };
      }
    }
  });
}
