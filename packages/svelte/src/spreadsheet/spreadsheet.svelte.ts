import {
  SpreadsheetController,
  bindSpreadsheetTableActions,
  createSpreadsheetEditorDocument,
  type SpreadsheetControllerOptions,
  type SpreadsheetDocument,
  type CellCoordinate,
  type CellRange,
  type CellData,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type SpreadsheetDataSource,
  type SpreadsheetNameScope,
  type SpreadsheetCommitResult,
  type SpreadsheetValidationAction,
  type SpreadsheetValidationPrompt
} from '@pixerate/editor/spreadsheet';

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
  // Invalid input waiting for the user (data validation alert).
  let validationPrompt = $state.raw<SpreadsheetValidationPrompt | null>(null);

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

  // What to render: visible rows (with group headers) and columns, frozen
  // offsets and merged-cell spans. Recomputed whenever the document changes.
  const viewModel = $derived.by(() => {
    void doc;
    return controller.getViewModel();
  });
  // Table operations (sort, filters, freeze, hide, merge, autofill, categories,
  // transpose, CSV, clipboard). The controller reports their changes through
  // onDocumentChange / onSelectionChange, which update the state above.
  const tableActions = bindSpreadsheetTableActions(controller);
  // Conditional formatting of every formatted cell (re-evaluated incrementally).
  const conditionalFormatOverlay = $derived.by(() => {
    void doc;
    return controller.getConditionalFormatOverlay();
  });

  // Input breaking a data validation rule is not committed: the editor stays
  // open and `validationPrompt` holds the alert until it is resolved.
  function syncEditing() {
    editingCell = controller.editingCell;
    draftValue = controller.draftValue;
    validationPrompt = controller.validationPrompt;
    activeCell = controller.activeCell;
    selectedRange = controller.selectedRange;
    doc = { ...controller.document };
  }

  // Sheet tabs and defined names. Every workbook change notifies through
  // onDocumentChange, so they follow `doc`.
  const sheets = $derived.by(() => {
    void doc;
    return controller.getSheets();
  });
  const names = $derived.by(() => {
    void doc;
    return controller.getNames();
  });

  // Switching sheets commits the edit in progress.
  function afterSheetSwitch() {
    doc = { ...controller.document };
    activeCell = controller.activeCell;
    selectedRange = controller.selectedRange;
    editingCell = controller.editingCell;
    draftValue = controller.draftValue;
  }

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
    get viewModel() {
      return viewModel;
    },
    get draftValue() {
      return draftValue;
    },
    /** The sheets in tab order (see `SpreadsheetController.getSheets`). */
    get sheets() {
      return sheets;
    },
    get activeSheetId() {
      void doc;
      return controller.activeSheetId;
    },
    /** Defined names (see `SpreadsheetController.getNames`). */
    get names() {
      return names;
    },
    set draftValue(val: string) {
      draftValue = val;
      controller.draftValue = val;
    },
    controller,
    /** The save / load / undo contract (for `createEditorAutosave` or `createDocumentToolProvider`). */
    editorDocument: createSpreadsheetEditorDocument(controller),

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
    get conditionalFormatOverlay() {
      return conditionalFormatOverlay;
    },
    get validationPrompt() {
      return validationPrompt;
    },
    commitEditing(val?: string): SpreadsheetCommitResult {
      const result = controller.commitEditing(val);
      syncEditing();
      return result;
    },
    /** Commits input from outside the cell editor (formula bar, list dropdown) with validation. */
    commitCellInput(rowId: string, colId: string, raw: string): SpreadsheetCommitResult {
      const result = controller.commitCellInput(rowId, colId, raw);
      syncEditing();
      return result;
    },
    /** Answers the validation alert: accept (warning / information), retry or cancel. */
    resolveValidationPrompt(action: SpreadsheetValidationAction) {
      controller.resolveValidationPrompt(action);
      syncEditing();
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
    autoFitColumnWidth(colId: string, customWidth?: number) {
      controller.autoFitColumnWidth(colId, customWidth);
      doc = { ...controller.document };
    },
    loadDocument(document: SpreadsheetDocument) {
      controller.loadDocument(document);
      doc = { ...controller.document };
      activeCell = controller.activeCell;
      selectedRange = controller.selectedRange;
      editingCell = controller.editingCell;
      draftValue = controller.draftValue;
    },
    syncWithDataSource() {
      controller.syncWithDataSource();
      controller.recalculateAll();
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
    exportToTsv(range?: CellRange | null) {
      return controller.exportToTsv(range);
    },
    importFromTsv(data: string) {
      controller.importFromTsv(data);
      doc = { ...controller.document };
    },
    // Undo can switch to the sheet the step belongs to.
    undo() {
      controller.undo();
      afterSheetSwitch();
    },
    redo() {
      controller.redo();
      afterSheetSwitch();
    },
    setActiveSheet(idOrName: string) {
      const changed = controller.setActiveSheet(idOrName);
      afterSheetSwitch();
      return changed;
    },
    addSheet(options?: Parameters<typeof controller.addSheet>[0]) {
      const id = controller.addSheet(options);
      afterSheetSwitch();
      return id;
    },
    renameSheet(idOrName: string, newName: string) {
      controller.renameSheet(idOrName, newName);
    },
    moveSheet(idOrName: string, toIndex: number) {
      return controller.moveSheet(idOrName, toIndex);
    },
    deleteSheet(idOrName: string) {
      const deleted = controller.deleteSheet(idOrName);
      afterSheetSwitch();
      return deleted;
    },
    duplicateSheet(idOrName: string, options?: Parameters<typeof controller.duplicateSheet>[1]) {
      const id = controller.duplicateSheet(idOrName, options);
      afterSheetSwitch();
      return id;
    },
    defineName(name: string, refersTo: string, options?: SpreadsheetNameScope & { comment?: string }) {
      controller.defineName(name, refersTo, options);
    },
    renameName(oldName: string, newName: string, options?: SpreadsheetNameScope) {
      controller.renameName(oldName, newName, options);
    },
    deleteName(name: string, options?: SpreadsheetNameScope) {
      return controller.deleteName(name, options);
    },
    ...tableActions
  };
}
