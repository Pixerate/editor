// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import {
  createPromptEditorOptions,
  promptEditorConfigKey,
  promptMilestones,
  resolvePromptTemplateColorMap,
  syncPromptEditor,
  PROMPT_EDITOR_DEFAULT_CLASS_NAME,
  PROMPT_EDITOR_DEFAULT_PLACEHOLDER,
  type PromptEditorConfig,
} from "../src";

const created: Editor[] = [];

beforeAll(() => {
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

afterEach(() => {
  for (const editor of created.splice(0)) if (!editor.isDestroyed) editor.destroy();
});

function createPromptEditor(config: Partial<PromptEditorConfig> = {}, reachedMilestones?: Set<string>) {
  let current: PromptEditorConfig = { content: "", onContentChange: () => {}, ...config };
  const editor = new Editor(createPromptEditorOptions(() => current, { reachedMilestones }));
  created.push(editor);
  return {
    editor,
    set(next: Partial<PromptEditorConfig>) {
      current = { ...current, ...next };
    },
  };
}

describe("createPromptEditorOptions", () => {
  it("builds a plain-text editor with the defaults", () => {
    const { editor } = createPromptEditor({ content: "line 1\nline 2" });
    expect(editor.getText({ blockSeparator: "\n" })).toBe("line 1\nline 2");
    expect(editor.isEditable).toBe(true);
    expect(editor.view.dom.getAttribute("role")).toBe("textbox");
    expect(editor.view.dom.getAttribute("class")).toContain(PROMPT_EDITOR_DEFAULT_CLASS_NAME);
    const placeholder = editor.extensionManager.extensions.find((e) => e.name === "placeholder");
    expect(placeholder?.options.placeholder).toBe(PROMPT_EDITOR_DEFAULT_PLACEHOLDER);
    expect(editor.extensionManager.extensions.some((e) => e.name === "fileImport")).toBe(false);
    expect(editor.extensionManager.extensions.some((e) => e.name === "heading")).toBe(false);
  });

  it("reads callbacks at call time, so handlers can change without recreating the editor", () => {
    const first = vi.fn();
    const second = vi.fn();
    const prompt = createPromptEditor({ onContentChange: first });
    prompt.set({ onContentChange: second });
    prompt.editor.commands.insertContent("hi");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenLastCalledWith("hi");
  });

  it("reports each milestone once across editors sharing the set", () => {
    const onMilestone = vi.fn();
    const reached = new Set<string>();
    const a = createPromptEditor({ onMilestone }, reached);
    a.editor.commands.insertContent("{subject}");
    a.editor.commands.insertContent(" {mood}");
    const b = createPromptEditor({ onMilestone }, reached);
    b.editor.commands.insertContent("{x} __magic__");
    expect(onMilestone.mock.calls.map((c) => c[0])).toEqual(["used_variable", "used_magic"]);
  });

  it("captures arrow keys and Enter while a slash menu is open, and Escape clears it", () => {
    const clearSlashCommand = vi.fn();
    const onEscape = vi.fn();
    const { editor } = createPromptEditor({ slashCommandActive: true, clearSlashCommand, onEscape });
    const handleKeyDown = editor.options.editorProps.handleKeyDown!;
    const key = (k: string) => new KeyboardEvent("keydown", { key: k, cancelable: true });
    expect(handleKeyDown(editor.view, key("ArrowDown"))).toBe(true);
    expect(handleKeyDown(editor.view, key("Enter"))).toBe(true);
    expect(handleKeyDown(editor.view, key("Escape"))).toBe(true);
    expect(clearSlashCommand).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    expect(handleKeyDown(editor.view, key("a"))).toBe(false);
  });

  it("calls onSlashCommandMatch for /command before the cursor and clears otherwise", () => {
    const container = document.createElement("div");
    container.id = "editor-container";
    document.body.appendChild(container);
    const onSlashCommandMatch = vi.fn();
    const clearSlashCommand = vi.fn();
    const { editor } = createPromptEditor({ onSlashCommandMatch, clearSlashCommand });
    editor.view.coordsAtPos = () => ({ top: 0, bottom: 10, left: 4, right: 4 });
    editor.commands.insertContent("go /temp");
    const [match, from, to] = onSlashCommandMatch.mock.calls.at(-1)!;
    expect(match[1]).toBe("temp");
    expect(editor.state.doc.textBetween(from, to)).toBe("/temp");
    editor.commands.insertContent(" ");
    expect(clearSlashCommand).toHaveBeenCalled();
    container.remove();
  });

  it("pastes plain text even when the clipboard carries HTML", () => {
    const onContentChange = vi.fn();
    const { editor } = createPromptEditor({ content: "Hello", onContentChange });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const event = {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? " a\nb" : "<b>x</b>") },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    expect(editor.options.editorProps.handlePaste?.(editor.view, event, null as any)).toBe(true);
    expect(onContentChange).toHaveBeenLastCalledWith("Hello a\nb");
  });
});

describe("syncPromptEditor", () => {
  it("applies editability, class names and placeholder to the live editor", () => {
    const { editor } = createPromptEditor({ content: "x" });
    syncPromptEditor(editor, { content: "x", onContentChange: () => {}, isEditing: false, className: "b", placeholder: "p" });
    expect(editor.isEditable).toBe(false);
    expect(editor.view.dom.classList.contains("b")).toBe(true);
    const placeholder = editor.extensionManager.extensions.find((e) => e.name === "placeholder");
    expect(placeholder?.options.placeholder).toBe("p");
  });

  it("applies parent content changes and ignores echoes and unchanged content", () => {
    const { editor } = createPromptEditor({ content: "start" });
    const base = { onContentChange: () => {} };
    const setContent = vi.spyOn(editor.commands, "setContent");

    editor.commands.insertContent(" typed");
    const typed = editor.getText();
    // Echo of the editor's own text: nothing to apply.
    syncPromptEditor(editor, { ...base, content: typed }, { ...base, content: "start" });
    // The parent did not take the edit up, but its content prop did not change either.
    syncPromptEditor(editor, { ...base, content: "start", className: "c" }, { ...base, content: "start" });
    expect(setContent).not.toHaveBeenCalled();
    expect(editor.getText()).toBe(typed);

    // Clearing after submit.
    syncPromptEditor(editor, { ...base, content: "" }, { ...base, content: "start" });
    expect(editor.getText()).toBe("");
  });
});

describe("prompt editor helpers", () => {
  it("keys the config by value", () => {
    const a = promptEditorConfigKey({ content: "a", onContentChange: () => {}, templateColorMap: new Map([["s", { from: "#000", to: "#fff" }]]) });
    const b = promptEditorConfigKey({ content: "b", onContentChange: () => {}, templateColorMap: new Map([["s", { from: "#000", to: "#fff" }]]) });
    expect(a).toBe(b);
    expect(promptEditorConfigKey({ content: "", onContentChange: () => {} }, { hasLoadingNodeView: true })).not.toBe(
      promptEditorConfigKey({ content: "", onContentChange: () => {} }),
    );
  });

  it("finds milestones with the core tokenizer", () => {
    expect(promptMilestones("plain")).toEqual([]);
    expect(promptMilestones("__magic__ and {v}")).toEqual(["used_magic", "used_variable"]);
  });

  it("gives each template a default gradient unless a map is passed", () => {
    expect([...resolvePromptTemplateColorMap([{ id: "1", name: "style" } as any]).keys()]).toEqual(["style"]);
    expect([...resolvePromptTemplateColorMap([]).keys()]).toEqual(["default"]);
    const map = new Map();
    expect(resolvePromptTemplateColorMap([], map)).toBe(map);
  });
});
