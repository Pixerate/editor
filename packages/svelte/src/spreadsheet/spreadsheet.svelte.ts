import {
  SpreadsheetController,
  type SpreadsheetControllerOptions,
  type SpreadsheetDocument,
  type CellCoordinate,
  type CellRange,
  type CellData,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type SpreadsheetDataSource
} from '@pixerate/editor';

export function createReactiveSpreadsheet(options: SpreadsheetControllerOptions = {}) {
  let doc = $state<SpreadsheetDocument>({
    id: options.document?.id || `sheet_${Date.now()}`,
    name: options.document?.name || 'Sheet 1',
    columns: options.document?.columns || [],
    rows: options.document?.rows || [],
    cells: options.document?.cells || {},
    createdAt: options.document?.createdAt || Date.now(),
    updatedAt: options.document?.updatedAt || Date.now()
  });

  let activeCell = $state<CellCoordinate | null>(null);
  let selectedRange = $state<CellRange | null>(null);
  let editingCell = $state<CellCoordinate | null>(null);
  let draftValue = $state<string>('');

  const controller = new SpreadsheetController({
    ...options,
    document: options.document,
    onDocumentChange: (updated) => {
      doc = { ...updated };
      options.onDocumentChange?.(updated);
    },
    onSelectionChange: (active, range) => {
      activeCell = active;
      selectedRange = range;
      options.onSelectionChange?.(active, range);
    },
    onCellCommit: (rowId, colId, raw, value) => {
      options.onCellCommit?.(rowId, colId, raw, value);
    }
  });

  // Keep initial states aligned
  doc = { ...controller.document };
  activeCell = controller.activeCell;
  selectedRange = controller.selectedRange;

  return {
    get document() {
      return doc;
    },
    get activeCell() {
      return activeCell;
    },
    get selectedRange() {
      return selectedRange;
    },
    get editingCell() {
      return editingCell;
    },
    get draftValue() {
      return draftValue;
    },
    set draftValue(val: string) {
      draftValue = val;
      controller.draftValue = val;
    },
    controller,

    getCell(rowId: string, colId: string): CellData {
      return controller.getCell(rowId, colId);
    },
    setCellValue(rowId: string, colId: string, raw: string) {
      controller.setCellValue(rowId, colId, raw);
      doc = { ...controller.document };
    },
    selectCell(row: number, col: number, extendSelection = false) {
      controller.selectCell(row, col, extendSelection);
      activeCell = controller.activeCell;
      selectedRange = controller.selectedRange;
    },
    selectRange(range: CellRange) {
      controller.selectRange(range);
      selectedRange = controller.selectedRange;
    },
    startEditing(row?: number, col?: number, initialVal?: string) {
      controller.startEditing(row, col, initialVal);
      activeCell = controller.activeCell;
      editingCell = controller.editingCell;
      draftValue = controller.draftValue;
    },
    commitEditing(val?: string) {
      controller.commitEditing(val);
      editingCell = null;
      draftValue = '';
      doc = { ...controller.document };
    },
    cancelEditing() {
      controller.cancelEditing();
      editingCell = null;
      draftValue = '';
    },
    moveCursor(dir: 'up' | 'down' | 'left' | 'right', extend = false) {
      controller.moveCursor(dir, extend);
      activeCell = controller.activeCell;
      selectedRange = controller.selectedRange;
    },
    insertColumn(index: number, config?: Partial<SpreadsheetColumn>) {
      controller.insertColumn(index, config);
      doc = { ...controller.document };
    },
    deleteColumn(colId: string) {
      controller.deleteColumn(colId);
      doc = { ...controller.document };
    },
    insertRow(index: number, config?: Partial<SpreadsheetRow>) {
      controller.insertRow(index, config);
      doc = { ...controller.document };
    },
    deleteRow(rowId: string) {
      controller.deleteRow(rowId);
      doc = { ...controller.document };
    },
    setColumnWidth(colId: string, width: number) {
      controller.setColumnWidth(colId, width);
      doc = { ...controller.document };
    },
    registerDataSource(ds: SpreadsheetDataSource) {
      controller.registerDataSource(ds);
      doc = { ...controller.document };
    },
    setPrimaryDataSource(id: string | undefined) {
      controller.setPrimaryDataSource(id);
      doc = { ...controller.document };
    },
    recalculateAll() {
      controller.recalculateAll();
      doc = { ...controller.document };
    },
    exportToTsv() {
      return controller.exportToTsv();
    },
    importFromTsv(data: string) {
      controller.importFromTsv(data);
      doc = { ...controller.document };
    },
    undo() {
      controller.undo();
      doc = { ...controller.document };
    },
    redo() {
      controller.redo();
      doc = { ...controller.document };
    }
  };
}
