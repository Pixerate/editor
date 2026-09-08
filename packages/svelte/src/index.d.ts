import type { Component } from "svelte";
import type { Editor, Content, Extensions, EditorOptions } from "@tiptap/core";
import type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
} from "@pixerate/editor";

export interface SvelteInitiateEditorOptions extends Partial<EditorOptions> {
  richTextOptions?: RichTextPresetOptions;
}

export declare const initiateEditor: (
  element?: HTMLElement,
  content?: Content,
  extensions?: Extensions,
  options?: SvelteInitiateEditorOptions,
) => Editor;

export interface ReactiveEditorState {
  editor: Editor | undefined;
  content: string;
  isEditable: boolean;
}

export declare function createReactiveEditor(
  initialContent?: string,
  extensions?: Extensions,
  options?: Partial<EditorOptions>,
): {
  readonly current: Editor | undefined;
  mount(element: HTMLElement): Editor;
  destroy(): void;
};

export interface EditableTextNodeEditorProps {
  class?: string;
  content?: Content;
  showMenu?: boolean;
  editable?: boolean;
  editor?: Editor;
  extensions?: Extensions;
  onUpdate?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onCreate?: () => void;
  placeholder?: string;
}

export interface BubbleMenuProps {
  editor?: Editor;
  class?: string;
  children?: any;
}

export interface TemplateRendererProps {
  content: string;
  templates?: Template[];
  templateColorMap?: Map<string, ColorGradient>;
  resolve?: boolean;
  class?: string;
  onTemplateClick?: (templateName: string) => void;
  onVariableClick?: (variableName: string) => void;
}

export declare const EditableTextNodeEditor: Component<EditableTextNodeEditorProps>;
export declare const BubbleMenu: Component<BubbleMenuProps>;
export declare const TemplateRenderer: Component<TemplateRendererProps>;

export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
};

import type {
  SpreadsheetController,
  SpreadsheetControllerOptions,
  SpreadsheetDocument,
  SpreadsheetColumn,
  SpreadsheetRow,
  CellCoordinate,
  CellRange,
  CellData,
  SpreadsheetDataSource
} from '@pixerate/editor';

export interface SpreadsheetEditorProps {
  sheetState: ReturnType<typeof createReactiveSpreadsheet>;
  readonly?: boolean;
  readOnly?: boolean;
  showFormulaBar?: boolean;
  class?: string;
  customCellRenderer?:
    | ((cell: CellData, col: SpreadsheetColumn, row: SpreadsheetRow) => any)
    | ((args: { cell: CellData; col: SpreadsheetColumn; row: SpreadsheetRow }) => any)
    | ((args: { row: SpreadsheetRow; col: SpreadsheetColumn; cell: CellData }) => any);
  onAddColumnClick?: () => void;
  onColumnHeaderClick?: (col: SpreadsheetColumn) => void;
}

export interface FormulaBarProps {
  sheetState: ReturnType<typeof createReactiveSpreadsheet>;
  class?: string;
}

export declare const SpreadsheetEditor: Component<SpreadsheetEditorProps>;
export declare const FormulaBar: Component<FormulaBarProps>;

export declare function createReactiveSpreadsheet(options?: SpreadsheetControllerOptions): {
  readonly document: SpreadsheetDocument;
  readonly activeCell: CellCoordinate | null;
  readonly selectedRange: CellRange | null;
  readonly editingCell: CellCoordinate | null;
  draftValue: string;
  controller: SpreadsheetController;
  getCell(rowId: string, colId: string): CellData;
  setCellValue(rowId: string, colId: string, raw: string): void;
  selectCell(row: number, col: number, extendSelection?: boolean): void;
  selectRange(range: CellRange): void;
  startEditing(row?: number, col?: number, initialVal?: string): void;
  commitEditing(val?: string): void;
  cancelEditing(): void;
  moveCursor(dir: 'up' | 'down' | 'left' | 'right', extend?: boolean): void;
  insertColumn(index: number, config?: Partial<SpreadsheetColumn>): void;
  deleteColumn(colId: string): void;
  insertRow(index: number, config?: Partial<SpreadsheetRow>): void;
  deleteRow(rowId: string): void;
  setColumnWidth(colId: string, width: number): void;
  loadDocument(document: SpreadsheetDocument): void;
  syncWithDataSource(): void;
  registerDataSource(ds: SpreadsheetDataSource): void;
  setPrimaryDataSource(id: string | undefined): void;
  recalculateAll(): void;
  exportToTsv(): string;
  importFromTsv(data: string): void;
  undo(): void;
  redo(): void;
};
