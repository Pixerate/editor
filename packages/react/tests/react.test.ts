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
});
