// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { usePromptEditor, type UsePromptEditorProps } from "../src";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type HarnessProps = Partial<UsePromptEditorProps> & {
  onEditor: (editor: Editor | null) => void;
};

function Harness({ onEditor, ...props }: HarnessProps) {
  const editor = usePromptEditor({
    content: "",
    onContentChange: () => {},
    ...props,
  } as UsePromptEditorProps);
  onEditor(editor);
  return null;
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

describe("usePromptEditor", () => {
  it("does not loop or recreate the editor when templateColorMap is passed inline", async () => {
    const editors = new Set<Editor>();
    const renders = { count: 0 };
    const onEditor = (e: Editor | null) => {
      renders.count++;
      if (e) editors.add(e);
    };
    const inlineMap = () =>
      new Map([["style", { from: "#000000", to: "#ffffff" }]]);

    await render({ onEditor, templateColorMap: inlineMap(), content: "hi" });
    await render({ onEditor, templateColorMap: inlineMap(), content: "hi" });
    await render({ onEditor, templateColorMap: inlineMap(), content: "hi" });

    expect(editors.size).toBe(1);
    expect(renders.count).toBeLessThan(10);
  });

  it("toggles editability on the same editor instance", async () => {
    let editor: Editor | null = null;
    const onEditor = (e: Editor | null) => (editor = e);

    await render({ onEditor, content: "hello", isEditing: true });
    const first = editor!;
    expect(first.isEditable).toBe(true);

    await render({ onEditor, content: "hello", isEditing: false });
    expect(editor).toBe(first);
    expect(first.isDestroyed).toBe(false);
    expect(first.isEditable).toBe(false);
  });

  it("keeps the same instance when the placeholder or className changes", async () => {
    let editor: Editor | null = null;
    const onEditor = (e: Editor | null) => (editor = e);

    await render({ onEditor, placeholder: "one", className: "a" });
    const first = editor!;
    await render({ onEditor, placeholder: "two", className: "b" });

    expect(editor).toBe(first);
    const placeholder = first.extensionManager.extensions.find(
      (ext) => ext.name === "placeholder",
    );
    expect(placeholder?.options.placeholder).toBe("two");
    expect(first.view.dom.classList.contains("b")).toBe(true);
    expect(first.view.dom.classList.contains("a")).toBe(false);
  });

  it("applies content changes from the parent, e.g. clearing after submit", async () => {
    let editor: Editor | null = null;
    const onEditor = (e: Editor | null) => (editor = e);

    await render({ onEditor, content: "hello" });
    expect(editor!.getText()).toBe("hello");

    await render({ onEditor, content: "" });
    expect(editor!.getText()).toBe("");

    await render({ onEditor, content: "line 1\nline 2" });
    expect(editor!.getText({ blockSeparator: "\n" })).toBe("line 1\nline 2");
  });

  it("does not reset the document when the parent echoes onContentChange", async () => {
    let editor: Editor | null = null;
    const onChange = vi.fn();

    function Controlled() {
      const [text, setText] = useState("start");
      editor = usePromptEditor({
        content: text,
        onContentChange: (t) => {
          onChange(t);
          setText(t);
        },
      });
      return null;
    }

    await act(async () => root.render(<Controlled />));
    const setContent = vi.spyOn(editor!.commands, "setContent");

    await act(async () => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      editor!.commands.insertContent(" more");
    });

    expect(onChange).toHaveBeenLastCalledWith("start more");
    expect(editor!.getText()).toBe("start more");
    expect(setContent).not.toHaveBeenCalled();
  });

  it("fires each milestone once, using the core tokenizer", async () => {
    let editor: Editor | null = null;
    const onMilestone = vi.fn();
    await render({ onEditor: (e) => (editor = e), onMilestone, content: "" });

    await act(async () => {
      editor!.commands.insertContent("__award_winning__ shot of {subject}");
    });
    await act(async () => {
      editor!.commands.insertContent(" more {mood} __x__");
    });

    expect(onMilestone.mock.calls.map((c) => c[0]).sort()).toEqual([
      "used_magic",
      "used_variable",
    ]);
  });
});
