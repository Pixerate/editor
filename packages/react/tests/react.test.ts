import { describe, it, expect } from "vitest";
import * as ReactEditor from "../src";

describe("@pixerate/editor-react Exports", () => {
  it("exports usePromptEditor, useEditor, EditorContent, BubbleMenu, and TemplateRenderer", () => {
    expect(ReactEditor.usePromptEditor).toBeDefined();
    expect(ReactEditor.useEditor).toBeDefined();
    expect(ReactEditor.EditorContent).toBeDefined();
    expect(ReactEditor.BubbleMenu).toBeDefined();
    expect(ReactEditor.TemplateRenderer).toBeDefined();
  });

  it("exports SpreadsheetEditor and useSpreadsheetEditor", () => {
    expect(ReactEditor.SpreadsheetEditor).toBeDefined();
    expect(ReactEditor.useSpreadsheetEditor).toBeDefined();
  });

  it("exports useNavigationGuard, useDismissGuard, and DirtyTracker", () => {
    expect(ReactEditor.useNavigationGuard).toBeDefined();
    expect(ReactEditor.useDismissGuard).toBeDefined();
    expect(ReactEditor.DirtyTracker).toBeDefined();
    expect(ReactEditor.createDirtyTracker).toBeDefined();
  });

  it("exports useHistory, useHistoryShortcuts, and HistoryManager", () => {
    expect(ReactEditor.useHistory).toBeDefined();
    expect(ReactEditor.useHistoryShortcuts).toBeDefined();
    expect(ReactEditor.HistoryManager).toBeDefined();
    expect(ReactEditor.createHistoryManager).toBeDefined();
  });
});
