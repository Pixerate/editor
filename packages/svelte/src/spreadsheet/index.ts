import type { ComponentProps } from "svelte";
import type SpreadsheetEditorComponent from "./SpreadsheetEditor.svelte";
import type FormulaBarComponent from "./FormulaBar.svelte";

export { default as SpreadsheetEditor } from './SpreadsheetEditor.svelte';
export { default as FormulaBar } from './FormulaBar.svelte';
export * from './spreadsheet.svelte.js';

export type SpreadsheetEditorProps = ComponentProps<typeof SpreadsheetEditorComponent>;
export type FormulaBarProps = ComponentProps<typeof FormulaBarComponent>;
