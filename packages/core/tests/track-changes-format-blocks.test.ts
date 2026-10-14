import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { closeHistory as closeHistoryEvent } from "@tiptap/pm/history";
import {
  BLOCK_CHANGE_ATTRIBUTE,
  FORMAT_CHANGE_MARK_NAME,
  TrackChanges,
  createRichTextPreset,
  describeBlockChange,
  describeFormatChange,
  getEditorMarkdown,
  getEditorText,
  getTrackedChangeAt,
  getTrackedChanges,
  resolveTrackedChanges,
  type TrackChangesOptions,
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
  options: { enabled?: boolean; markdown?: boolean; preset?: Record<string, any> } & Partial<TrackChangesOptions> = {},
) {
  let id = 0;
  const { enabled = true, markdown = false, preset = {}, ...track } = options;
  return new Editor({
    extensions: [
      ...createRichTextPreset({ markdown, ...preset }),
      TrackChanges.configure({
        enabled,
        author: alice,
        generateId: () => `ch-${++id}`,
        now: () => 42,
        ...track,
      }),
    ],
    content,
  });
}

function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.view.dispatch(editor.state.tr.insertText(ch));
  }
}

/** Starts a new undo event (history groups quick adjacent edits). */
function closeHistory(editor: Editor) {
  editor.view.dispatch(closeHistoryEvent(editor.state.tr));
}

const summary = (editor: Editor) =>
  getTrackedChanges(editor).map((c) => `${c.type}:${c.description}`);

describe("Tracked formatting changes", () => {
  it("records bolding existing text as one format change", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "ch-1",
      type: "format",
      text: "world",
      from: 7,
      to: 12,
      author: { id: "alice", name: "Alice" },
      createdAt: 42,
      description: "Formatted: Bold",
      format: { added: ["Bold"], removed: [], changed: [] },
    });
    const html = editor.getHTML();
    expect(html).toContain('data-change-type="format"');
    expect(html).toContain("pixerate-format-change");
    expect(html).toContain("decoration-dotted");
    expect(html).toMatch(/<strong><span[^>]*data-change-type="format"[^>]*>world<\/span><\/strong>/);
    editor.destroy();
  });

  it("accept keeps the new formatting, reject restores the old, each one undo step", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    const [change] = getTrackedChanges(editor);

    expect(editor.commands.acceptChange(change.id)).toBe(true);
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(editor.getHTML()).toBe("<p>Hello <strong>world</strong></p>");
    editor.commands.undo();
    expect(summary(editor)).toEqual(["format:Formatted: Bold"]);

    expect(editor.commands.rejectChange(change.id)).toBe(true);
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.undo();
    expect(summary(editor)).toEqual(["format:Formatted: Bold"]);
    // Undoing the original edit removes formatting and record together.
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.destroy();
  });

  it("records removed formatting and restores it on reject", () => {
    const editor = createEditor("<p>Hello <em>world</em></p>");
    editor.chain().setTextSelection({ from: 7, to: 12 }).unsetItalic().run();
    expect(summary(editor)).toEqual(["format:Removed formatting: Italic"]);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>Hello <em>world</em></p>");
    editor.destroy();
  });

  it("drops the record when the formatting is changed back", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.destroy();
  });

  it("merges adjacent and repeated formatting by the same author", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 6, to: 12 }).toggleBold().run();
    let changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: "ch-1", text: "Hello world", from: 1, to: 12 });

    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleItalic().run();
    changes = getTrackedChanges(editor);
    expect(changes.map((c) => c.id)).toEqual(["ch-1"]);
    expect(changes[0].description).toBe("Formatted: Bold, Italic");

    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.destroy();
  });

  it("keeps the original formatting when another author reformats", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    editor.commands.setTrackChangesAuthor(bob);
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleItalic().run();
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ author: { id: "bob" }, description: "Formatted: Bold, Italic" });
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.destroy();
  });

  it("typing formatted text is an insertion, and formatting an insertion adds no record", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(12);
    editor.commands.toggleBold();
    type(editor, "!!");
    expect(summary(editor)).toEqual(['insertion:Inserted "!!"']);
    editor.chain().setTextSelection({ from: 12, to: 14 }).toggleItalic().run();
    expect(summary(editor)).toEqual(['insertion:Inserted "!!"']);
    // Formatting a range spanning old and new text only records the old part.
    editor.chain().setTextSelection({ from: 9, to: 14 }).toggleUnderline().run();
    const changes = getTrackedChanges(editor);
    expect(changes.map((c) => `${c.type}:${c.text}`)).toEqual(["format:rld", "insertion:!!"]);
    editor.destroy();
  });

  it("describes font size, links and highlight changes", () => {
    const editor = createEditor("<p>one two three</p>");
    editor.chain().setTextSelection({ from: 1, to: 4 }).setFontSize("20px").run();
    editor.chain().setTextSelection({ from: 5, to: 8 }).setLink({ href: "https://a.dev" }).run();
    editor.chain().setTextSelection({ from: 9, to: 14 }).setHighlight({ color: "#ff0" }).run();
    expect(summary(editor)).toEqual([
      "format:Formatted: Font size",
      "format:Formatted: Link",
      "format:Formatted: Highlight",
    ]);
    // Changing the font size again keeps the original (no size) as "before".
    editor.chain().setTextSelection({ from: 1, to: 4 }).setFontSize("24px").run();
    expect(getTrackedChanges(editor)[0].description).toBe("Formatted: Font size");
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>one two three</p>");
    editor.destroy();
  });

  it("describes changed attributes of an existing mark", () => {
    const editor = createEditor('<p><span style="font-size: 12px">big</span></p>');
    editor.chain().setTextSelection({ from: 1, to: 4 }).setFontSize("30px").run();
    expect(summary(editor)).toEqual(["format:Changed formatting: Font size"]);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe('<p><span style="font-size: 12px;">big</span></p>');
    editor.destroy();
  });

  it("does not track comment or bookmark marks", () => {
    const editor = createEditor("<p>Hello world</p>", {
      preset: { comments: true, bookmarks: true },
    });
    editor.chain().setTextSelection({ from: 7, to: 12 }).addComment({ body: "Hi" }).run();
    editor.chain().setTextSelection({ from: 1, to: 6 }).setBookmark({ name: "start" }).run();
    expect(getTrackedChanges(editor)).toEqual([]);
    // Formatting commented text records only the formatting.
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    const [change] = getTrackedChanges(editor);
    expect(change.format).toEqual({ added: ["Bold"], removed: [], changed: [] });
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toContain('data-comment-id');
    expect(editor.getHTML()).not.toContain("<strong>");
    editor.destroy();
  });

  it("treats a replace step that only changes marks as formatting", () => {
    const editor = createEditor();
    const { schema } = editor.state;
    editor.view.dispatch(
      editor.state.tr.replaceWith(7, 12, schema.text("world", [schema.marks.bold.create()])),
    );
    expect(summary(editor)).toEqual(["format:Formatted: Bold"]);
    expect(editor.getText()).toBe("Hello world");
    editor.destroy();
  });

  it("combines with deletions: reject all restores text and formatting", () => {
    const editor = createEditor();
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 7, to: 12 }).deleteSelection().run();
    expect(getTrackedChanges(editor).map((c) => c.type).sort()).toEqual(["deletion", "format"]);
    expect(getEditorText(editor)).toBe("Hello ");
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.commands.undo();
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe("<p>Hello </p>");
    editor.destroy();
  });

  it("is off with trackFormatting: false", () => {
    const editor = createEditor("<p>Hello world</p>", { trackFormatting: false });
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("uses overridable HTML attributes", () => {
    const editor = createEditor("<p>Hello world</p>", {
      formatChangeHTMLAttributes: { class: "my-format" },
    });
    editor.chain().setTextSelection({ from: 7, to: 12 }).toggleBold().run();
    expect(editor.getHTML()).toContain('class="my-format"');
    expect(editor.getHTML()).not.toContain("decoration-dotted");
    editor.destroy();
  });

  it("strips format records from pasted content", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(12);
    editor.view.pasteHTML(
      '<p><span data-change-type="format" data-change-id="x" data-format-before="[]" data-format-after=\'[{"type":"bold"}]\'><strong>!</strong></span></p>',
    );
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["insertion"]);
    expect(editor.getHTML()).toContain("<strong><ins");
    expect(editor.getHTML()).not.toContain('data-change-type="format"');
    editor.destroy();
  });
});

describe("Tracked block changes", () => {
  it("records a paragraph turned into a heading", () => {
    const editor = createEditor("<p>Title</p><p>Body</p>");
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "ch-1",
      type: "block",
      text: "Title",
      from: 0,
      to: 7,
      description: "Changed Paragraph to Heading 2",
      block: {
        previous: { type: "paragraph", wrappers: [] },
        current: { type: "heading", attrs: { level: 2 }, wrappers: [] },
      },
    });
    const html = editor.getHTML();
    expect(html).toContain("data-block-change=");
    expect(html).toContain("pixerate-block-change");
    expect(html).toContain("border-l-2");
    editor.destroy();
  });

  it("accepts, rejects and undoes block changes", () => {
    const editor = createEditor("<p>Title</p><p>Body</p>");
    editor.chain().setTextSelection(2).toggleHeading({ level: 1 }).run();
    const [change] = getTrackedChanges(editor);

    editor.commands.acceptChange(change.id);
    expect(editor.getHTML()).toBe('<h1 class="font-bold tracking-tight">Title</h1><p>Body</p>');
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.undo();
    expect(summary(editor)).toEqual(["block:Changed Paragraph to Heading 1"]);

    editor.commands.rejectChange(change.id);
    expect(editor.getHTML()).toBe("<p>Title</p><p>Body</p>");
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.undo();
    expect(summary(editor)).toEqual(["block:Changed Paragraph to Heading 1"]);
    editor.destroy();
  });

  it("keeps the original state across repeated changes and drops it when reverted", () => {
    const editor = createEditor("<h1>Title</h1>");
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    expect(summary(editor)).toEqual(["block:Changed Heading 1 to Heading 2"]);
    editor.chain().setTextSelection(2).toggleHeading({ level: 3 }).run();
    expect(summary(editor)).toEqual(["block:Changed Heading 1 to Heading 3"]);
    expect(getTrackedChanges(editor)[0].id).toBe("ch-1");
    editor.chain().setTextSelection(2).toggleHeading({ level: 1 }).run();
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("records alignment changes", () => {
    const editor = createEditor("<p>Hello</p>");
    const before = editor.state.doc.firstChild!.attrs.textAlign;
    editor.chain().setTextSelection(2).setTextAlign("center").run();
    expect(editor.state.doc.firstChild!.attrs.textAlign).toBe("center");
    expect(summary(editor)).toEqual(["block:Changed alignment to Center"]);
    editor.commands.rejectAllChanges();
    expect(editor.state.doc.firstChild!.attrs.textAlign).toBe(before);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("records list wrapping as one change and restores the paragraphs on reject", () => {
    const original = "<p>one</p><p>two</p><p>three</p>";
    const editor = createEditor(original);
    editor.chain().setTextSelection({ from: 2, to: 9 }).toggleBulletList().run();
    expect(editor.state.doc.firstChild!.type.name).toBe("bulletList");
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toBe("Wrapped in Bulleted list");
    expect(changes[0].text).toBe("onetwo");
    expect(changes[0].ranges).toHaveLength(2);

    closeHistory(editor);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe(original);
    editor.commands.undo();
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe(
      '<ul class="list-disc pl-4"><li><p>one</p></li><li><p>two</p></li></ul><p>three</p>',
    );
    editor.destroy();
  });

  it("records lifting items out of a list and rebuilds the list on reject", () => {
    const original =
      '<ul class="list-disc pl-4"><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>';
    const editor = createEditor(original);
    // Lift the last two items.
    editor.chain().setTextSelection({ from: 10, to: 20 }).liftListItem("listItem").run();
    expect(editor.state.doc.childCount).toBe(3);
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toBe("Removed from Bulleted list");
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe(original);
    editor.destroy();
  });

  it("records blockquotes and list type changes", () => {
    const editor = createEditor("<p>quote</p>");
    editor.chain().setTextSelection(2).toggleBlockquote().run();
    expect(summary(editor)).toEqual(["block:Wrapped in Quote"]);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>quote</p>");
    editor.destroy();

    const original = '<ul class="list-disc pl-4"><li><p>a</p></li><li><p>b</p></li></ul>';
    const list = createEditor(original);
    list.chain().setTextSelection(3).toggleOrderedList().run();
    expect(list.state.doc.firstChild!.type.name).toBe("orderedList");
    expect(summary(list).every((s) => s === "block:Changed Bulleted list to Numbered list")).toBe(true);
    list.commands.rejectAllChanges();
    expect(list.getHTML()).toBe(original);
    list.destroy();
  });

  it("records indenting and outdenting list items and restores the nesting on reject", () => {
    const flat =
      '<ul class="list-disc pl-4"><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>';
    const editor = createEditor(flat);
    editor.chain().setTextSelection(9).sinkListItem("listItem").run();
    expect(editor.getHTML()).toContain("<li><p>a</p><ul");
    expect(summary(editor)).toEqual(["block:Indented in Bulleted list"]);
    closeHistory(editor);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe(flat);
    editor.destroy();

    const nested =
      '<ul class="list-disc pl-4"><li><p>a</p><ul class="list-disc pl-4"><li><p>b</p></li><li><p>c</p></li></ul></li></ul>';
    const other = createEditor(nested);
    // Outdent the last nested item ("c"). Outdenting an item with following
    // siblings re-parents them, which is not recorded (see GOTCHAS.md).
    other.chain().setTextSelection(13).liftListItem("listItem").run();
    expect(other.getHTML()).toMatch(/<li><p>b<\/p><\/li><\/ul><\/li><li><p [^>]*>c<\/p><\/li><\/ul>$/);
    expect(summary(other)).toEqual(["block:Outdented from Bulleted list"]);
    closeHistory(other);
    other.commands.rejectAllChanges();
    expect(other.getHTML()).toBe(nested);
    other.destroy();
  });

  it("records converting to a code block and restores the paragraph on reject", () => {
    const editor = createEditor("<p>let x</p>");
    editor.chain().setTextSelection(2).toggleCodeBlock().run();
    expect(editor.state.doc.firstChild!.type.name).toBe("codeBlock");
    expect(summary(editor)).toEqual(["block:Changed Paragraph to Code block"]);
    // Typing in the converted block is tracked too.
    editor.commands.setTextSelection(6);
    type(editor, "y");
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["block", "insertion"]);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>let x</p>");
    editor.destroy();
  });

  it("does not copy block records to split-off blocks or track splits", () => {
    const editor = createEditor("<p>Title</p>");
    editor.chain().setTextSelection(2).toggleHeading({ level: 1 }).run();
    editor.commands.setTextSelection(6);
    editor.commands.enter();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).attrs[BLOCK_CHANGE_ATTRIBUTE] ?? null).toBeNull();
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["block"]);
    editor.destroy();
  });

  it("prefers inline changes at the caret and navigates into block content", () => {
    const editor = createEditor("<p>Title</p><p>Body</p>");
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    editor.commands.setTextSelection(6);
    type(editor, "!");
    expect(getTrackedChangeAt(editor.state)?.type).toBe("insertion");
    editor.commands.setTextSelection(3);
    expect(getTrackedChangeAt(editor.state)?.type).toBe("block");

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.selectNextChange();
    expect(editor.state.selection).toMatchObject({ from: 1, to: 7 });
    expect(getTrackedChangeAt(editor.state)?.type).toBe("block");
    editor.commands.selectNextChange();
    expect(getTrackedChangeAt(editor.state)?.type).toBe("insertion");
    editor.destroy();
  });

  it("accepts and rejects mixed kinds in one undo step", () => {
    const original = "<p>Title</p><p>Body text</p>";
    const editor = createEditor(original);
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    editor.chain().setTextSelection({ from: 8, to: 12 }).toggleBold().run();
    editor.commands.setTextSelection(17);
    type(editor, "!");
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["block", "format", "insertion"]);

    closeHistory(editor);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe(original);
    editor.commands.undo();
    expect(getTrackedChanges(editor)).toHaveLength(3);
    editor.commands.acceptAllChanges();
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(editor.getHTML()).toBe(
      '<h2 class="font-bold tracking-tight">Title</h2><p><strong>Body</strong> text!</p>',
    );
    editor.destroy();
  });

  it("is off with trackBlocks: false", () => {
    const editor = createEditor("<p>Title</p>", { trackBlocks: false });
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(editor.state.schema.nodes.heading.spec.attrs?.[BLOCK_CHANGE_ATTRIBUTE]).toBeUndefined();
    editor.destroy();
  });

  it("uses an overridable block class", () => {
    const editor = createEditor("<p>Title</p>", { blockChangeClass: "my-bar" });
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    expect(editor.getHTML()).toContain("my-bar");
    expect(editor.getHTML()).not.toContain("border-l-2");
    editor.destroy();
  });
});

describe("Descriptions", () => {
  it("describes formatting summaries", () => {
    expect(describeFormatChange({ added: ["Bold"], removed: [], changed: [] })).toBe("Formatted: Bold");
    expect(
      describeFormatChange({ added: ["Bold"], removed: ["Italic"], changed: ["Font size"] }),
    ).toBe("Formatted: Bold; Removed formatting: Italic; Changed formatting: Font size");
    expect(describeFormatChange({ added: [], removed: [], changed: [] })).toBe("Formatted");
  });

  it("describes block changes", () => {
    const p = { type: "paragraph", attrs: {}, wrappers: [] };
    const list = [
      { type: "bulletList", attrs: {} },
      { type: "listItem", attrs: {} },
    ];
    expect(describeBlockChange(p, { type: "heading", attrs: { level: 3 }, wrappers: [] })).toBe(
      "Changed Paragraph to Heading 3",
    );
    expect(describeBlockChange(p, { ...p, wrappers: list })).toBe("Wrapped in Bulleted list");
    expect(describeBlockChange({ ...p, wrappers: list }, p)).toBe("Removed from Bulleted list");
    expect(describeBlockChange({ ...p, wrappers: list }, { ...p, wrappers: [...list, ...list] })).toBe(
      "Indented in Bulleted list",
    );
    expect(describeBlockChange({ ...p, wrappers: [...list, ...list] }, { ...p, wrappers: list })).toBe(
      "Outdented from Bulleted list",
    );
    expect(describeBlockChange(p, { type: "codeBlock", attrs: {}, wrappers: [] })).toBe(
      "Changed Paragraph to Code block",
    );
  });
});

describe("Tracked formatting and blocks in serializers", () => {
  const html =
    '<h2 data-block-change=\'{"changeId":"b1","authorId":"bob","authorName":"Bob","authorColor":null,"createdAt":1,"previous":{"type":"paragraph","attrs":{"textAlign":"left"},"wrappers":[]}}\'>Title</h2>' +
    '<p>Hello <span data-change-type="format" data-change-id="f1" data-author-id="bob" data-format-before="[]" data-format-after=\'[{"type":"bold"}]\'><strong>world</strong></span></p>';

  it("parses records from HTML", () => {
    const editor = createEditor(html, { enabled: false });
    const changes = getTrackedChanges(editor);
    expect(changes.map((c) => `${c.type}:${c.id}:${c.description}`)).toEqual([
      "block:b1:Changed Paragraph to Heading 2",
      "format:f1:Formatted: Bold",
    ]);
    expect(changes[0].author).toEqual({ id: "bob", name: "Bob" });
    editor.destroy();
  });

  it("resolveTrackedChanges applies the accepted or original formatting", () => {
    const editor = createEditor(html, { enabled: false });
    const doc = editor.state.doc;
    const accepted = resolveTrackedChanges(doc);
    expect(accepted.firstChild!.type.name).toBe("heading");
    expect(accepted.firstChild!.attrs[BLOCK_CHANGE_ATTRIBUTE]).toBeNull();
    expect(accepted.child(1).child(1).marks.map((m) => m.type.name)).toEqual(["bold"]);

    const original = resolveTrackedChanges(doc, "original");
    expect(original.firstChild!.type.name).toBe("paragraph");
    expect(original.child(1).child(0).marks).toEqual([]);
    expect(original.child(1).textContent).toBe("Hello world");
    // The editor document is untouched.
    expect(doc.firstChild!.type.name).toBe("heading");
    expect(doc.child(1).child(1).marks.some((m) => m.type.name === FORMAT_CHANGE_MARK_NAME)).toBe(true);
    editor.destroy();
  });

  it("getEditorMarkdown exports the new formatting by default and the old with original", () => {
    const editor = createEditor(html, { enabled: false, markdown: true });
    expect(getEditorMarkdown(editor)).toBe("## Title\n\nHello **world**");
    expect(getEditorMarkdown(editor, { trackedChanges: "original" })).toBe("Title\n\nHello world");
    expect(getEditorMarkdown(editor, { trackedChanges: "all" })).toBe("## Title\n\nHello **world**");
    editor.destroy();
  });
});
