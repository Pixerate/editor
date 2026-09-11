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

  it("exports canvas runes and utilities from @pixerate/editor-svelte/canvas", async () => {
    const CanvasModule = await import("../dist/canvas");
    expect(CanvasModule.createCanvasGraph).toBeDefined();
    expect(CanvasModule.calculateGraphDifferences).toBeDefined();
    expect(CanvasModule.replaceNodeInGraph).toBeDefined();
    expect(CanvasModule.getLayoutedNodes).toBeDefined();
    expect(CanvasModule.getCenteredNodePosition).toBeDefined();
    expect(CanvasModule.centerNodes).toBeDefined();
    expect(CanvasModule.createCanvasClipboard).toBeDefined();
    expect(CanvasModule.isEventFromTextInput).toBeDefined();
    expect(CanvasModule.isValidCanvasNode).toBeDefined();
    expect(CanvasModule.isValidUrl).toBeDefined();
    expect(CanvasModule.createCanvasDocking).toBeDefined();
    expect(CanvasModule.createCanvasShortcuts).toBeDefined();
    expect(CanvasModule.createCanvasInteractions).toBeDefined();
    expect(CanvasModule.defaultSvelteFlowPreset).toBeDefined();
    expect(CanvasModule.miroCompatiblePreset).toBeDefined();
    expect(CanvasModule.restorePanelPointerEvents).toBeDefined();
  });
});

