import { useState, useRef, useCallback, useMemo } from 'react';
import {
  SpreadsheetController,
  bindSpreadsheetTableActions,
  type SpreadsheetControllerOptions,
  type SpreadsheetDocument,
  type CellCoordinate,
  type CellRange,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type SpreadsheetDataSource,
  type SpreadsheetDocument as SheetDocument,
  type SpreadsheetNameScope,
  type SpreadsheetCommitResult,
  type SpreadsheetValidationAction,
  type SpreadsheetValidationPrompt
} from '@pixerate/editor/spreadsheet';

export function useSpreadsheetEditor(options: SpreadsheetControllerOptions = {}) {
  // Callbacks are read through a ref so they are never stale.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const settersRef = useRef<{
    setDoc?: (doc: SpreadsheetDocument) => void;
    setActiveCell?: (cell: CellCoordinate | null) => void;
    setSelectedRange?: (range: CellRange | null) => void;
  }>({});

  // Create the controller first so the initial state reflects its document
  // (including default rows and columns when no document is passed).
  const [controller] = useState(
    () =>
      new SpreadsheetController({
        ...options,
        onDocumentChange: (updated) => {
          settersRef.current.setDoc?.({ ...updated });
          optionsRef.current.onDocumentChange?.(updated);
        },
        onSelectionChange: (active, range) => {
          settersRef.current.setActiveCell?.(active);
          settersRef.current.setSelectedRange?.(range);
          optionsRef.current.onSelectionChange?.(active, range);
        },
        onCellCommit: (rowId, colId, raw, value) => {
          optionsRef.current.onCellCommit?.(rowId, colId, raw, value);
        },
      }),
  );

  const [doc, setDoc] = useState<SpreadsheetDocument>(() => ({ ...controller.document }));
  const [activeCell, setActiveCell] = useState<CellCoordinate | null>(controller.activeCell);
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(controller.selectedRange);
  const [editingCell, setEditingCell] = useState<CellCoordinate | null>(null);
  const [draftValue, setDraftState] = useState<string>('');
  // Invalid input waiting for the user (data validation alert).
  const [validationPrompt, setValidationPrompt] = useState<SpreadsheetValidationPrompt | null>(null);
  settersRef.current = { setDoc, setActiveCell, setSelectedRange };

  // The controller commits its own `draftValue` (`commitEditing()` without an
  // argument), so typed text must reach it, not just React state.
  const setDraftValue = useCallback((value: string) => {
    controller.draftValue = value;
    setDraftState(value);
  }, [controller]);

  const setCellValue = useCallback((rowId: string, colId: string, raw: string) => {
    controller.setCellValue(rowId, colId, raw);
    setDoc({ ...controller.document });
  }, [controller]);

  const selectCell = useCallback((row: number, col: number, extendSelection = false) => {
    controller.selectCell(row, col, extendSelection);
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
  }, [controller]);

  const selectRange = useCallback((range: CellRange) => {
    controller.selectRange(range);
    setSelectedRange(controller.selectedRange);
  }, [controller]);

  const startEditing = useCallback((row?: number, col?: number, initialVal?: string) => {
    controller.startEditing(row, col, initialVal);
    setActiveCell(controller.activeCell);
    setEditingCell(controller.editingCell);
    setDraftValue(controller.draftValue);
  }, [controller]);

  // Input breaking a data validation rule is not committed: the editor stays
  // open and `validationPrompt` holds the alert until it is resolved.
  const syncEditing = useCallback(() => {
    setEditingCell(controller.editingCell);
    setDraftValue(controller.draftValue);
    setValidationPrompt(controller.validationPrompt);
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
    setDoc({ ...controller.document });
  }, [controller]);

  const commitEditing = useCallback((val?: string): SpreadsheetCommitResult => {
    const result = controller.commitEditing(val);
    syncEditing();
    return result;
  }, [controller, syncEditing]);

  /** Commits input from outside the cell editor (formula bar, list dropdown) with validation. */
  const commitCellInput = useCallback((rowId: string, colId: string, raw: string): SpreadsheetCommitResult => {
    const result = controller.commitCellInput(rowId, colId, raw);
    syncEditing();
    return result;
  }, [controller, syncEditing]);

  /** Answers the validation alert: accept (warning / information), retry or cancel. */
  const resolveValidationPrompt = useCallback((action: SpreadsheetValidationAction) => {
    controller.resolveValidationPrompt(action);
    syncEditing();
  }, [controller, syncEditing]);

  const cancelEditing = useCallback(() => {
    controller.cancelEditing();
    setEditingCell(null);
    setDraftValue('');
  }, [controller]);

  const moveCursor = useCallback((dir: 'up' | 'down' | 'left' | 'right', extend = false) => {
    controller.moveCursor(dir, extend);
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
  }, [controller]);

  const insertColumn = useCallback((index: number, config?: Partial<SpreadsheetColumn>) => {
    controller.insertColumn(index, config);
    setDoc({ ...controller.document });
  }, [controller]);

  const deleteColumn = useCallback((colId: string) => {
    controller.deleteColumn(colId);
    setDoc({ ...controller.document });
  }, [controller]);

  const insertRow = useCallback((index: number, config?: Partial<SpreadsheetRow>) => {
    controller.insertRow(index, config);
    setDoc({ ...controller.document });
  }, [controller]);

  const deleteRow = useCallback((rowId: string) => {
    controller.deleteRow(rowId);
    setDoc({ ...controller.document });
  }, [controller]);

  const setColumnWidth = useCallback((colId: string, width: number) => {
    controller.setColumnWidth(colId, width);
    setDoc({ ...controller.document });
  }, [controller]);

  const autoFitColumnWidth = useCallback((colId: string, customWidth?: number) => {
    controller.autoFitColumnWidth(colId, customWidth);
    setDoc({ ...controller.document });
  }, [controller]);

  const registerDataSource = useCallback((ds: SpreadsheetDataSource) => {
    controller.registerDataSource(ds);
    setDoc({ ...controller.document });
  }, [controller]);

  const setPrimaryDataSource = useCallback((id: string | undefined) => {
    controller.setPrimaryDataSource(id);
    setDoc({ ...controller.document });
  }, [controller]);

  const recalculateAll = useCallback(() => {
    controller.recalculateAll();
    setDoc({ ...controller.document });
  }, [controller]);

  // Undo can switch to the sheet the step belongs to.
  const undo = useCallback(() => {
    controller.undo();
    setDoc({ ...controller.document });
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
  }, [controller]);

  const redo = useCallback(() => {
    controller.redo();
    setDoc({ ...controller.document });
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
  }, [controller]);

  // Table operations (sort, filters, freeze, hide, merge, autofill, categories,
  // transpose, CSV, clipboard). The controller reports their changes through
  // onDocumentChange / onSelectionChange, which update the state above.
  const tableActions = useMemo(() => bindSpreadsheetTableActions(controller), [controller]);
  // What to render: visible rows (with group headers) and columns, frozen
  // offsets and merged-cell spans. Recomputed whenever the document changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewModel = useMemo(() => controller.getViewModel(), [controller, doc]);
  // Sheet tabs and defined names. Every workbook change notifies through
  // onDocumentChange, so they follow `doc`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sheets = useMemo(() => controller.getSheets(), [controller, doc]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const names = useMemo(() => controller.getNames(), [controller, doc]);

  // Switching sheets commits the edit in progress.
  const afterSheetSwitch = useCallback(() => {
    setEditingCell(controller.editingCell);
    setDraftValue(controller.draftValue);
    setActiveCell(controller.activeCell);
    setSelectedRange(controller.selectedRange);
    setDoc({ ...controller.document });
  }, [controller, setDraftValue]);

  const workbookActions = useMemo(
    () => ({
      setActiveSheet: (idOrName: string) => {
        const changed = controller.setActiveSheet(idOrName);
        afterSheetSwitch();
        return changed;
      },
      addSheet: (options?: { name?: string; index?: number; document?: Partial<SheetDocument>; activate?: boolean }) => {
        const id = controller.addSheet(options);
        afterSheetSwitch();
        return id;
      },
      renameSheet: (idOrName: string, newName: string) => controller.renameSheet(idOrName, newName),
      moveSheet: (idOrName: string, toIndex: number) => controller.moveSheet(idOrName, toIndex),
      deleteSheet: (idOrName: string) => {
        const deleted = controller.deleteSheet(idOrName);
        afterSheetSwitch();
        return deleted;
      },
      duplicateSheet: (idOrName: string, options?: { name?: string; index?: number; activate?: boolean }) => {
        const id = controller.duplicateSheet(idOrName, options);
        afterSheetSwitch();
        return id;
      },
      defineName: (name: string, refersTo: string, options?: SpreadsheetNameScope & { comment?: string }) =>
        controller.defineName(name, refersTo, options),
      renameName: (oldName: string, newName: string, options?: SpreadsheetNameScope) =>
        controller.renameName(oldName, newName, options),
      deleteName: (name: string, options?: SpreadsheetNameScope) => controller.deleteName(name, options),
    }),
    [controller, afterSheetSwitch],
  );

  // Conditional formatting of every formatted cell (re-evaluated incrementally).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const conditionalFormatOverlay = useMemo(() => controller.getConditionalFormatOverlay(), [controller, doc]);

  return {
    document: doc,
    activeCell,
    selectedRange,
    editingCell,
    draftValue,
    setDraftValue,
    validationPrompt,
    resolveValidationPrompt,
    commitCellInput,
    controller,
    getCell: (rowId: string, colId: string) => controller.getCell(rowId, colId),
    setCellValue,
    selectCell,
    selectRange,
    startEditing,
    commitEditing,
    cancelEditing,
    moveCursor,
    insertColumn,
    deleteColumn,
    insertRow,
    deleteRow,
    setColumnWidth,
    autoFitColumnWidth,
    loadDocument: (document: SpreadsheetDocument) => {
      controller.loadDocument(document);
      setDoc({ ...controller.document });
      setActiveCell(null);
      setSelectedRange(null);
      setEditingCell(null);
      setDraftValue('');
    },
    syncWithDataSource: () => {
      controller.syncWithDataSource();
      controller.recalculateAll();
      setDoc({ ...controller.document });
    },
    registerDataSource,
    setPrimaryDataSource,
    recalculateAll,
    exportToTsv: (range?: CellRange | null) => controller.exportToTsv(range),
    importFromTsv: (data: string) => {
      controller.importFromTsv(data);
      setDoc({ ...controller.document });
    },
    ...tableActions,
    viewModel,
    /** The sheets in tab order (see `SpreadsheetController.getSheets`). */
    sheets,
    activeSheetId: controller.activeSheetId,
    /** Defined names (see `SpreadsheetController.getNames`). */
    names,
    ...workbookActions,
    conditionalFormatOverlay,
    undo,
    redo
  };
}
