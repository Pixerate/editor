import { describe, it, expect } from "vitest";
import * as SvelteEditor from "../src";

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

  it("exports ImageEditor and createReactiveImageEditor", () => {
    expect(SvelteEditor.ImageEditor).toBeDefined();
    expect(SvelteEditor.createReactiveImageEditor).toBeDefined();
  });

  it("exports navigationGuard, createNavigationGuard, and DirtyTracker", () => {
    expect(SvelteEditor.navigationGuard).toBeDefined();
    expect(SvelteEditor.createNavigationGuard).toBeDefined();
    expect(SvelteEditor.DirtyTracker).toBeDefined();
    expect(SvelteEditor.createDirtyTracker).toBeDefined();
  });

  it("exports createHistory, createHistoryShortcuts, and HistoryManager", () => {
    expect(SvelteEditor.createHistory).toBeDefined();
    expect(SvelteEditor.createHistoryShortcuts).toBeDefined();
    expect(SvelteEditor.HistoryManager).toBeDefined();
    expect(SvelteEditor.createHistoryManager).toBeDefined();
  });

  it("exports canvas runes and utilities from @pixerate/editor-svelte/canvas", async () => {
    const CanvasModule = await import("../src/canvas");
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
    expect(CanvasModule.createCanvasNodeSync).toBeDefined();
    expect(CanvasModule.preserveNodeMeasurements).toBeDefined();
    expect(CanvasModule.normalizeNodeHandles).toBeDefined();
    expect(CanvasModule.createCanvasMultiDrag).toBeDefined();
    expect(CanvasModule.getMarqueeSelectionPreset).toBeDefined();
    expect(CanvasModule.FloatingHorizontalScrollbar).toBeDefined();
  }, 15000);

  it("defaults autofocus to false in initiateEditor, and respects explicit autofocus", () => {
    const editorDefault = SvelteEditor.initiateEditor();
    expect(editorDefault.options.autofocus).toBe(false);
    editorDefault.destroy();

    const editorAutofocus = SvelteEditor.initiateEditor(
      undefined,
      undefined,
      undefined,
      { autofocus: true },
    );
    expect(editorAutofocus.options.autofocus).toBe(true);
    editorAutofocus.destroy();
  });
});
