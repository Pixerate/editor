import { describe, it, expect } from "vitest";
import * as SvelteEditor from "../dist";

describe("@pixerate/editor-svelte Distribution Exports", () => {
  it("exports initiateEditor, EditableTextNodeEditor, BubbleMenu, TemplateRenderer, and createReactiveEditor", () => {
    expect(SvelteEditor.initiateEditor).toBeDefined();
    expect(SvelteEditor.createReactiveEditor).toBeDefined();
    expect(SvelteEditor.EditableTextNodeEditor).toBeDefined();
    expect(SvelteEditor.BubbleMenu).toBeDefined();
    expect(SvelteEditor.TemplateRenderer).toBeDefined();
  });

  it("exports SpreadsheetEditor, FormulaBar, and createReactiveSpreadsheet", () => {
    expect(SvelteEditor.SpreadsheetEditor).toBeDefined();
    expect(SvelteEditor.FormulaBar).toBeDefined();
    expect(SvelteEditor.createReactiveSpreadsheet).toBeDefined();
  });
});
