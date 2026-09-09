import { useState, useMemo, useCallback } from 'react';
import {
  SpreadsheetController,
  type SpreadsheetControllerOptions,
  type SpreadsheetDocument,
  type CellCoordinate,
  type CellRange,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type SpreadsheetDataSource
} from '@pixerate/editor';

export function useSpreadsheetEditor(options: SpreadsheetControllerOptions = {}) {
  const [doc, setDoc] = useState<SpreadsheetDocument>(() => ({
    id: options.document?.id || `sheet_${Date.now()}`,
    name: options.document?.name || 'Sheet 1',
    columns: options.document?.columns || [],
    rows: options.document?.rows || [],
    cells: options.document?.cells || {},
    createdAt: options.document?.createdAt || Date.now(),
    updatedAt: options.document?.updatedAt || Date.now()
  }));

  const [activeCell, setActiveCell] = useState<CellCoordinate | null>(null);
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<CellCoordinate | null>(null);
  const [draftValue, setDraftValue] = useState<string>('');

  const controller = useMemo(() => {
    return new SpreadsheetController({
      ...options,
      onDocumentChange: (updated) => {
        setDoc({ ...updated });
        options.onDocumentChange?.(updated);
      },
      onSelectionChange: (active, range) => {
        setActiveCell(active);
        setSelectedRange(range);
        options.onSelectionChange?.(active, range);
      },
      onCellCommit: (rowId, colId, raw, value) => {
        options.onCellCommit?.(rowId, colId, raw, value);
      }
    });
  }, []);

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

  const commitEditing = useCallback((val?: string) => {
    controller.commitEditing(val);
    setEditingCell(null);
    setDraftValue('');
    setDoc({ ...controller.document });
  }, [controller]);

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

  const undo = useCallback(() => {
    controller.undo();
    setDoc({ ...controller.document });
  }, [controller]);

  const redo = useCallback(() => {
    controller.redo();
    setDoc({ ...controller.document });
  }, [controller]);

  return {
    document: doc,
    activeCell,
    selectedRange,
    editingCell,
    draftValue,
    setDraftValue,
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
    exportToTsv: () => controller.exportToTsv(),
    importFromTsv: (data: string) => {
      controller.importFromTsv(data);
      setDoc({ ...controller.document });
    },
    undo,
    redo
  };
}
