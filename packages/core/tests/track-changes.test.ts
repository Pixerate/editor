import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  TrackChanges,
  TRACK_CHANGES_SKIP_META,
  createRichTextPreset,
  getEditorMarkdown,
  getEditorText,
  getTrackChangesStore,
  getTrackedChangeAt,
  getTrackedChanges,
  htmlToPlainText,
  isTrackChangesEnabled,
  resolveTrackedChanges,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).ClipboardEvent =
    (dom.window as any).ClipboardEvent ?? class extends dom.window.Event {};
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };

function createEditor(
  content = "<p>Hello world</p>",
  options: { enabled?: boolean; markdown?: boolean } = {},
) {
  let id = 0;
  return new Editor({
    extensions: [
      ...createRichTextPreset({ markdown: options.markdown ?? false }),
      TrackChanges.configure({
        enabled: options.enabled ?? true,
        author: alice,
        generateId: () => `ch-${++id}`,
        now: () => 42,
      }),
    ],
    content,
  });
}

/** Types text one character at a time, like keystrokes. */
function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.view.dispatch(editor.state.tr.insertText(ch));
  }
}

/**
 * Browsers delete single characters natively and ProseMirror turns the DOM
 * change into a `ReplaceStep`; dispatch the equivalent transaction.
 */
function backspace(editor: Editor, times = 1) {
  for (let i = 0; i < times; i++) {
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete(from - 1, from));
  }
}

function forwardDelete(editor: Editor, times = 1) {
  for (let i = 0; i < times; i++) {
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete(from, from + 1));
  }
}

const summary = (editor: Editor) =>
  getTrackedChanges(editor).map((c) => `${c.type}:${c.text}`);

describe("TrackChanges extension", () => {
  it("is off by default and toggles via commands", () => {
    const editor = createEditor("<p>Hi</p>", { enabled: false });
    expect(isTrackChangesEnabled(editor)).toBe(false);
    editor.commands.setTextSelection(3);
    type(editor, "!");
    expect(getTrackedChanges(editor)).toEqual([]);

    editor.commands.toggleTrackChanges();
    expect(isTrackChangesEnabled(editor)).toBe(true);
    type(editor, "?");
    expect(summary(editor)).toEqual(["insertion:?"]);

    editor.commands.setTrackChanges(false);
    expect(isTrackChangesEnabled(editor)).toBe(false);
    editor.destroy();

    // Toggling tracking is not an undo step.
    const fresh = createEditor("<p>Hi</p>", { enabled: false });
    fresh.commands.toggleTrackChanges();
    expect(fresh.can().undo()).toBe(false);
    fresh.destroy();
  });

  it("is opt-in via createRichTextPreset", () => {
    expect(createRichTextPreset().some((e: any) => e.name === "trackChanges")).toBe(false);
    const editor = new Editor({
      extensions: createRichTextPreset({ trackChanges: { enabled: true, author: bob } }),
      content: "<p>a</p>",
    });
    expect(isTrackChangesEnabled(editor)).toBe(true);
    editor.destroy();
  });

  it("marks typed text as one insertion per run of typing", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    type(editor, " big");
    expect(editor.getText()).toBe("Hello big world");
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "ch-1",
      type: "insertion",
      text: " big",
      author: { id: "alice", name: "Alice" },
      createdAt: 42,
      from: 6,
      to: 10,
    });
    expect(editor.getHTML()).toContain('<ins class="pixerate-insertion');
    expect(editor.getHTML()).toContain('data-change-id="ch-1"');
    editor.destroy();
  });

  it("keeps deleted text with a deletion mark on backspace and merges runs", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    backspace(editor, 3);
    expect(editor.getText()).toBe("Hello world");
    expect(summary(editor)).toEqual(["deletion:llo"]);
    // The caret moves before the struck text so Backspace keeps going backwards.
    expect(editor.state.selection.from).toBe(3);
    expect(editor.getHTML()).toContain("<del");
    expect(editor.getHTML()).toContain('data-change-type="deletion"');
    editor.destroy();
  });

  it("backspacing over already-deleted text just moves past it", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    backspace(editor, 2); // deletes "lo"
    editor.commands.setTextSelection(6); // after the struck "lo"
    backspace(editor, 3); // over "o", "l", then deletes "l"
    expect(summary(editor)).toEqual(["deletion:llo"]);
    expect(editor.state.selection.from).toBe(3);
    editor.destroy();
  });

  it("forward delete keeps the caret after the struck text", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(1);
    forwardDelete(editor, 2);
    expect(summary(editor)).toEqual(["deletion:He"]);
    expect(editor.state.selection.from).toBe(3);
    editor.destroy();
  });

  it("deleting your own insertion really deletes it", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    type(editor, " big");
    backspace(editor, 2);
    expect(editor.getText()).toBe("Hello b world");
    expect(summary(editor)).toEqual(["insertion: b"]);
    editor.destroy();
  });

  it("deleting another author's insertion marks it as deleted", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    type(editor, "!!");
    editor.commands.setTrackChangesAuthor(bob);
    backspace(editor, 1);
    expect(editor.getText()).toBe("Hello!! world");
    const changes = getTrackedChanges(editor);
    expect(changes.map((c) => `${c.type}:${c.author.id}:${c.text}`)).toEqual([
      "insertion:alice:!!",
      "deletion:bob:!",
    ]);
    // Accepting Bob's deletion removes the character.
    const deletion = changes.find((c) => c.type === "deletion")!;
    editor.commands.acceptChange(deletion.id);
    expect(editor.getText()).toBe("Hello! world");
    editor.destroy();
  });

  it("typing over a selection records a deletion followed by an insertion", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    type(editor, "there");
    expect(editor.getText()).toBe("Hello worldthere");
    expect(summary(editor)).toEqual(["deletion:world", "insertion:there"]);
    expect(editor.state.selection.from).toBe(17);
    expect(getEditorText(editor)).toBe("Hello there");
    expect(getEditorText(editor, { trackedChanges: "original" })).toBe("Hello world");
    expect(getEditorText(editor, { trackedChanges: "all" })).toBe("Hello worldthere");
    editor.destroy();
  });

  it("deleting a range across paragraphs keeps the text and the paragraphs", () => {
    const editor = createEditor("<p>one two</p><p>three four</p>");
    // "two</p><p>three"
    editor.commands.setTextSelection({ from: 5, to: 15 });
    editor.commands.deleteSelection();
    expect(editor.getHTML()).toContain("</p><p>");
    expect(editor.state.doc.childCount).toBe(2);
    expect(getTrackedChanges(editor).map((c) => c.text)).toEqual(["twothree"]);
    expect(getEditorText(editor)).toBe("one \n four");
    editor.destroy();
  });

  it("does not track paragraph splits and joins", () => {
    const editor = createEditor("<p>ab</p>");
    editor.commands.setTextSelection(2);
    editor.commands.enter();
    expect(editor.state.doc.childCount).toBe(2);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.joinBackward();
    expect(editor.state.doc.childCount).toBe(1);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("tracks pasted content and drops deleted text from pasted tracked content", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    editor.view.pasteHTML(
      '<p>, <del data-change-type="deletion" data-change-id="x">old</del><ins data-change-type="insertion" data-change-id="y" data-author-id="bob">new</ins></p>',
    );
    expect(editor.getText()).toBe("Hello, new world");
    expect(summary(editor)).toEqual(["insertion:, new"]);
    expect(getTrackedChanges(editor)[0].author.id).toBe("alice");
    editor.destroy();
  });

  it("pasting plain text over a selection is tracked", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.view.pasteText("Goodbye");
    expect(summary(editor)).toEqual(["deletion:Hello", "insertion:Goodbye"]);
    editor.destroy();
  });

  it("accepts and rejects single changes as single undo steps", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    type(editor, "there");
    const [deletion, insertion] = getTrackedChanges(editor);

    expect(editor.commands.acceptChange(deletion.id)).toBe(true);
    expect(editor.getText()).toBe("Hello there");
    expect(summary(editor)).toEqual(["insertion:there"]);
    editor.commands.undo();
    expect(summary(editor)).toEqual(["deletion:world", "insertion:there"]);

    expect(editor.commands.rejectChange(insertion.id)).toBe(true);
    expect(editor.getText()).toBe("Hello world");
    expect(summary(editor)).toEqual(["deletion:world"]);

    expect(editor.commands.rejectChange(deletion.id)).toBe(true);
    expect(editor.getText()).toBe("Hello world");
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(editor.getHTML()).toBe("<p>Hello world</p>");

    expect(editor.commands.acceptChange("missing")).toBe(false);
    editor.destroy();
  });

  it("accepts and rejects all changes in one undo step", () => {
    const editor = createEditor("<p>one two three</p>");
    editor.commands.setTextSelection({ from: 5, to: 8 });
    type(editor, "2");
    editor.commands.setTextSelection(1);
    type(editor, "> ");

    editor.commands.acceptAllChanges();
    expect(editor.getText()).toBe("> one 2 three");
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.undo();
    expect(getTrackedChanges(editor)).toHaveLength(3);

    editor.commands.rejectAllChanges();
    expect(editor.getText()).toBe("one two three");
    expect(editor.getHTML()).toBe("<p>one two three</p>");
    expect(editor.commands.rejectAllChanges()).toBe(false);
    editor.destroy();
  });

  it("undo reverts a tracked edit without re-tracking it", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(6);
    backspace(editor, 1);
    expect(summary(editor)).toEqual(["deletion:o"]);
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.commands.redo();
    expect(summary(editor)).toEqual(["deletion:o"]);
    editor.destroy();
  });

  it("skips transactions flagged with TRACK_CHANGES_SKIP_META", () => {
    const editor = createEditor();
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta(TRACK_CHANGES_SKIP_META, true);
        return true;
      })
      .setContent("<p>Replaced</p>")
      .run();
    expect(editor.getHTML()).toBe("<p>Replaced</p>");
    editor.destroy();
  });

  it("navigates between changes and finds the change at the caret", () => {
    const editor = createEditor("<p>one two three</p>");
    editor.commands.setTextSelection(4);
    type(editor, "!");
    editor.commands.setTextSelection(15);
    type(editor, "?");
    editor.commands.setTextSelection(1);

    expect(editor.commands.selectNextChange()).toBe(true);
    expect(editor.state.selection).toMatchObject({ from: 4, to: 5 });
    expect(getTrackedChangeAt(editor.state)?.text).toBe("!");
    editor.commands.selectNextChange();
    expect(getTrackedChangeAt(editor.state)?.text).toBe("?");
    editor.commands.selectNextChange(); // wraps
    expect(getTrackedChangeAt(editor.state)?.text).toBe("!");
    editor.commands.selectPreviousChange(); // wraps backwards
    expect(getTrackedChangeAt(editor.state)?.text).toBe("?");
    editor.commands.selectPreviousChange();
    expect(getTrackedChangeAt(editor.state)?.text).toBe("!");
    editor.destroy();
  });

  it("exposes a cached external store snapshot", () => {
    const editor = createEditor();
    const store = getTrackChangesStore(editor)!;
    const listener = vi.fn();
    store.subscribe(listener);
    const first = store.getSnapshot();
    expect(first).toMatchObject({ enabled: true, changes: [], currentChangeId: null });
    expect(store.getSnapshot()).toBe(first);

    editor.commands.setTextSelection(6);
    type(editor, "!");
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.changes.map((c) => c.text)).toEqual(["!"]);
    expect(second.currentChangeId).toBe("ch-1");
    expect(listener).toHaveBeenCalled();

    editor.commands.setTrackChanges(false);
    expect(store.getSnapshot().enabled).toBe(false);
    editor.destroy();
  });

  it("defers tracking during IME composition until it ends", async () => {
    vi.useFakeTimers();
    try {
      const editor = createEditor();
      let composing = true;
      Object.defineProperty(editor.view, "composing", { get: () => composing, configurable: true });
      editor.commands.setTextSelection(6);
      type(editor, "かな");
      expect(getTrackedChanges(editor)).toEqual([]);

      composing = false;
      editor.view.dom.dispatchEvent(new (window as any).Event("compositionend"));
      vi.runAllTimers();
      expect(summary(editor)).toEqual(["insertion:かな"]);
      editor.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks insertions and deletions inside code blocks", () => {
    const editor = createEditor("<pre><code>let x</code></pre>");
    editor.commands.setTextSelection(6);
    type(editor, "y");
    backspace(editor, 2);
    // "y" was the author's own insertion (really deleted); "x" is kept as a deletion.
    expect(editor.getText()).toBe("let x");
    expect(summary(editor)).toEqual(["deletion:x"]);
    expect(editor.state.doc.firstChild!.type.name).toBe("codeBlock");
    expect(editor.getHTML()).toContain("<pre><code>let <del");
    // Formatting is still not allowed in code blocks.
    expect(editor.state.schema.nodes.codeBlock.allowsMarkType(editor.state.schema.marks.bold)).toBe(false);
    editor.commands.rejectAllChanges();
    expect(editor.getText()).toBe("let x");
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("does not track inside code blocks with trackCodeBlocks: false", () => {
    const editor = new Editor({
      extensions: [
        ...createRichTextPreset({ markdown: false }),
        TrackChanges.configure({ enabled: true, author: alice, trackCodeBlocks: false }),
      ],
      content: "<pre><code>let x</code></pre>",
    });
    editor.commands.setTextSelection(6);
    type(editor, "y");
    backspace(editor, 2);
    expect(editor.getText()).toBe("let ");
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });
});

describe("Tracked content in serializers", () => {
  const html =
    '<p>Hello <del data-change-type="deletion" data-change-id="1">cruel </del><ins data-change-type="insertion" data-change-id="2">kind </ins>world</p>';

  it("htmlToPlainText drops deletions by default", () => {
    expect(htmlToPlainText(html)).toBe("Hello kind world");
    expect(htmlToPlainText(html, { trackedChanges: "accepted" })).toBe("Hello kind world");
    expect(htmlToPlainText(html, { trackedChanges: "original" })).toBe("Hello cruel world");
    expect(htmlToPlainText(html, { trackedChanges: "all" })).toBe("Hello cruel kind world");
    // Ordinary <del>/<ins> elements are left alone.
    expect(htmlToPlainText("<p>a <del>b</del> c</p>")).toBe("a b c");
  });

  it("htmlToPlainText drops deletions without a DOM", () => {
    const doc = globalThis.document;
    // @ts-expect-error simulate Node.js
    delete globalThis.document;
    try {
      expect(htmlToPlainText(html)).toBe("Hello kind world");
      expect(htmlToPlainText(html, { trackedChanges: "original" })).toBe("Hello cruel world");
    } finally {
      globalThis.document = doc;
    }
  });

  it("resolveTrackedChanges returns accepted / original documents", () => {
    const editor = createEditor(html, { enabled: false });
    const doc = editor.state.doc;
    expect(resolveTrackedChanges(doc).textContent).toBe("Hello kind world");
    expect(resolveTrackedChanges(doc, "original").textContent).toBe("Hello cruel world");
    expect(resolveTrackedChanges(doc, "all")).toBe(doc);
    // The editor document is untouched.
    expect(doc.textContent).toBe("Hello cruel kind world");
    editor.destroy();
  });

  it("getEditorMarkdown exports accepted content by default", () => {
    const editor = createEditor(html, { enabled: false, markdown: true });
    expect(getEditorMarkdown(editor)).toBe("Hello kind world");
    expect(getEditorMarkdown(editor, { trackedChanges: "original" })).toBe("Hello cruel world");
    expect(getEditorMarkdown(editor, { trackedChanges: "all" })).toBe("Hello ~~cruel~~ kind world");
    editor.destroy();
  });

  it("getEditorMarkdown falls back to accepted plain text without the markdown extension", () => {
    const editor = createEditor(html, { enabled: false });
    expect(getEditorMarkdown(editor)).toBe("Hello kind world");
    editor.destroy();
  });
});
