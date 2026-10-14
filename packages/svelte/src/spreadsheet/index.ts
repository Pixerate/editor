import type { ComponentProps } from "svelte";
import type SpreadsheetEditorComponent from "./SpreadsheetEditor.svelte";
import type FormulaBarComponent from "./FormulaBar.svelte";
import type FormulaHintsComponent from "./FormulaHints.svelte";
import type SheetTabsComponent from "./SheetTabs.svelte";
import type NameManagerComponent from "./NameManager.svelte";

export { default as SpreadsheetEditor } from './SpreadsheetEditor.svelte';
export { default as FormulaBar } from './FormulaBar.svelte';
export { default as FormulaHints } from './FormulaHints.svelte';
export { default as SheetTabs } from './SheetTabs.svelte';
export { default as NameManager } from './NameManager.svelte';
export * from './spreadsheet.svelte.js';
export { default as SpreadsheetContextMenu } from './SpreadsheetContextMenu.svelte';
export { default as SpreadsheetGroupRow } from './SpreadsheetGroupRow.svelte';
export * from './tableInteractions.js';
export { default as SpreadsheetValidationDialog } from './SpreadsheetValidationDialog.svelte';
export { default as SpreadsheetConditionalFormatPanel } from './SpreadsheetConditionalFormatPanel.svelte';
export { default as SpreadsheetDataValidationPanel } from './SpreadsheetDataValidationPanel.svelte';

export type SpreadsheetEditorProps = ComponentProps<typeof SpreadsheetEditorComponent>;
export type FormulaBarProps = ComponentProps<typeof FormulaBarComponent>;
export type FormulaHintsProps = ComponentProps<typeof FormulaHintsComponent>;
export type SheetTabsProps = ComponentProps<typeof SheetTabsComponent>;
export type NameManagerProps = ComponentProps<typeof NameManagerComponent>;
