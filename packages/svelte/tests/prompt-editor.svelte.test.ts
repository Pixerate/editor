import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { flushSync } from "svelte";
import type { Editor } from "@tiptap/core";
import {
  usePromptEditor,
  createPromptEditor,
  type UsePromptEditorProps,
  type SveltePromptEditor,
} from "../src";
import LoadingProbe from "./fixtures/LoadingProbe.svelte";

let cleanups: Array<() => void> = [];

beforeAll(() => {
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function setupPromptEditor(getProps: () => Partial<UsePromptEditorProps>): SveltePromptEditor {
  let handle!: SveltePromptEditor;
  const cleanup = $effect.root(() => {
    handle = usePromptEditor(() => ({
      content: "",
      onContentChange: () => {},
      ...getProps(),
    }));
  });
  flushSync();
  cleanups.push(cleanup);
  return handle;
}

describe("usePromptEditor (Svelte)", () => {
  it("aliases createPromptEditor to usePromptEditor", () => {
    expect(createPromptEditor).toBe(usePromptEditor);
  });

  it("does not loop or recreate the editor when templateColorMap is passed inline", () => {
    const editors = new Set<Editor>();
    let step = $state(0);
    const inlineMap = () =>
      new Map([["style", { from: "#000000", to: "#ffffff" }]]);

    const prompt = setupPromptEditor(() => {
      void step;
      return { templateColorMap: inlineMap(), content: "hi" };
    });
    if (prompt.editor) editors.add(prompt.editor);

    step = 1;
    flushSync();
    if (prompt.editor) editors.add(prompt.editor);

    step = 2;
    flushSync();
    if (prompt.editor) editors.add(prompt.editor);

    expect(editors.size).toBe(1);
  });

  it("toggles editability on the same editor instance", () => {
    let isEditing = $state(true);
    const prompt = setupPromptEditor(() => ({ content: "hello", isEditing }));
    const first = prompt.editor!;
    expect(first.isEditable).toBe(true);

    isEditing = false;
    flushSync();
    expect(prompt.editor).toBe(first);
    expect(first.isDestroyed).toBe(false);
    expect(first.isEditable).toBe(false);
  });

  it("keeps the same instance when the placeholder or className changes", () => {
    let placeholder = $state("one");
    let className = $state("a");
    const prompt = setupPromptEditor(() => ({ placeholder, className }));
    const first = prompt.editor!;

    placeholder = "two";
    className = "b";
    flushSync();

    expect(prompt.editor).toBe(first);
    const placeholderExt = first.extensionManager.extensions.find(
      (ext) => ext.name === "placeholder",
    );
    expect(placeholderExt?.options.placeholder).toBe("two");
    expect(first.view.dom.classList.contains("b")).toBe(true);
    expect(first.view.dom.classList.contains("a")).toBe(false);
  });

  it("applies content changes from the parent, e.g. clearing after submit", () => {
    let content = $state("hello");
    const prompt = setupPromptEditor(() => ({ content }));
    expect(prompt.editor!.getText()).toBe("hello");

    content = "";
    flushSync();
    expect(prompt.editor!.getText()).toBe("");

    content = "line 1\nline 2";
    flushSync();
    expect(prompt.editor!.getText({ blockSeparator: "\n" })).toBe("line 1\nline 2");
  });

  it("does not reset the document when the parent echoes onContentChange", () => {
    let text = $state("start");
    const onChange = vi.fn();
    const prompt = setupPromptEditor(() => ({
      content: text,
      onContentChange: (t) => {
        onChange(t);
        text = t;
      },
    }));

    const editor = prompt.editor!;
    const setContent = vi.spyOn(editor.commands, "setContent");

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(" more");
    flushSync();

    expect(onChange).toHaveBeenLastCalledWith("start more");
    expect(editor.getText()).toBe("start more");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("fires each milestone once, using the core tokenizer", () => {
    const onMilestone = vi.fn();
    const prompt = setupPromptEditor(() => ({ onMilestone, content: "" }));
    const editor = prompt.editor!;

    editor.commands.insertContent("__award_winning__ shot of {subject}");
    flushSync();
    editor.commands.insertContent(" more {mood} __x__");
    flushSync();

    expect(onMilestone.mock.calls.map((c) => c[0]).sort()).toEqual([
      "used_magic",
      "used_variable",
    ]);
  });

  it("pastes plain text via handlePaste even when clipboard carries HTML, and mounts via action", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    cleanups.push(() => container.remove());

    let latest = "";
    const prompt = setupPromptEditor(() => ({
      content: "Hello",
      onContentChange: (t) => {
        latest = t;
      },
    }));
    const actionHandle = prompt.action(container);
    const editor = prompt.editor!;
    expect(container.contains(editor.view.dom)).toBe(true);

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const pasteEvent = {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? " line 1\nline 2" : "<b>bold</b>",
      },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;

    const handled = editor.options.editorProps.handlePaste?.(
      editor.view,
      pasteEvent,
      null as any,
    );
    expect(handled).toBe(true);
    expect(pasteEvent.preventDefault).toHaveBeenCalled();
    expect(latest).toBe("Hello line 1\nline 2");
    actionHandle.destroy();
  });

  describe("loading placeholders", () => {
    const insertPlaceholder = (editor: Editor) => {
      editor.commands.insertContent({ type: "loadingNode", attrs: { id: "job-1" } });
      flushSync();
      return editor.view.dom.querySelector('span[data-type="loading"]') as HTMLElement;
    };

    it("draws an accessible SVG spinner by default", () => {
      const prompt = setupPromptEditor(() => ({}));
      const placeholder = insertPlaceholder(prompt.editor!);
      expect(placeholder.getAttribute("role")).toBe("status");
      expect(placeholder.getAttribute("aria-label")).toBe("Loading…");
      expect(placeholder.querySelector("svg")).not.toBeNull();
      expect(placeholder.textContent).not.toContain("⏳");
    });

    it("draws a custom loader with the label, and swaps it without recreating the editor", () => {
      const editors = new Set<Editor>();
      let indicator = $state<any>(LoadingProbe);
      const prompt = setupPromptEditor(() => ({
        loadingIndicator: indicator,
        loadingLabel: "Generating",
      }));
      editors.add(prompt.editor!);

      const placeholder = insertPlaceholder(prompt.editor!);
      expect(placeholder.getAttribute("aria-label")).toBe("Generating");
      expect(placeholder.querySelector("svg")).toBeNull();
      const probe = placeholder.querySelector(".probe-loader") as HTMLElement;
      expect(probe.dataset.job).toBe("job-1");
      expect(probe.textContent).toBe("Generating");

      // Swapping to another component reference keeps the same Editor instance.
      const AlternateProbe = ((...args: Parameters<typeof LoadingProbe>) =>
        LoadingProbe(...args)) as unknown as typeof LoadingProbe;
      indicator = AlternateProbe;
      flushSync();
      editors.add(prompt.editor!);
      expect(editors.size).toBe(1);
    });
  });
});
