import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  createRichTextPreset,
  getEditorMarkdown,
  computeOutline,
  buildOutlineTree,
  getOutline,
  getActiveHeading,
  createOutlineStore,
  navigateToHeading,
  outlinePluginKey,
  getTableOfContentsEntries,
  getFootnotes,
  getBookmarks,
  getCrossReferenceTargets,
  getDocumentStructureCommandItems,
  documentStructureCommandItems,
  type RichTextPresetOptions,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

let idSeq = 0;
const nextId = () => `id${++idSeq}`;

function createEditor(content: string, options: RichTextPresetOptions = {}) {
  const editor = new Editor({
    extensions: createRichTextPreset({
      outline: { generateId: nextId },
      tableOfContents: true,
      footnotes: { generateId: nextId },
      bookmarks: { generateId: nextId },
      crossReferences: true,
      ...options,
    }),
    content,
  });
  editors.push(editor);
  return editor;
}

/** Position just inside the first text node containing `text`, plus offset. */
function posOf(editor: Editor, text: string, offset = 0): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) {
      found = pos + node.text!.indexOf(text) + offset;
    }
    return true;
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

function select(editor: Editor, from: number, to = from) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

describe("Outline", () => {
  it("assigns unique, stable ids to headings and derives levels and depth", () => {
    const editor = createEditor(
      "<h1>Intro</h1><p>a</p><h3>Deep</h3><h2>Section</h2><h1>End</h1>",
    );
    const outline = getOutline(editor);
    expect(outline.map((h) => [h.text, h.level, h.depth])).toEqual([
      ["Intro", 1, 0],
      ["Deep", 3, 1],
      ["Section", 2, 1],
      ["End", 1, 0],
    ]);
    const ids = outline.map((h) => h.id);
    expect(new Set(ids).size).toBe(4);
    expect(editor.getHTML()).toContain(`id="${ids[0]}">Intro</h1>`);

    // Editing text keeps ids.
    select(editor, posOf(editor, "Intro", 5));
    editor.commands.insertContent(" more");
    expect(getOutline(editor)[0]).toMatchObject({ id: ids[0], text: "Intro more" });
  });

  it("keeps existing ids from HTML and builds a nested tree", () => {
    const editor = createEditor(
      '<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3><h2 id="d">D</h2>',
    );
    const tree = buildOutlineTree(getOutline(editor));
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("a");
    expect(tree[0].children.map((c) => c.id)).toEqual(["b", "d"]);
    expect(tree[0].children[0].children.map((c) => c.id)).toEqual(["c"]);
  });

  it("gives a split or duplicated heading a new id", () => {
    const editor = createEditor('<h1 id="a">Hello World</h1>');
    select(editor, posOf(editor, "World"));
    editor.commands.splitBlock();
    editor.commands.insertContentAt(editor.state.doc.content.size, '<h1 id="a">Copy</h1>');
    const ids = getOutline(editor).map((h) => h.id);
    expect(ids[0]).toBe("a");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reuses the outline array when an edit does not touch headings", () => {
    const editor = createEditor("<h1>Title</h1><p>body</p>");
    const before = outlinePluginKey.getState(editor.state);
    select(editor, posOf(editor, "body", 4));
    editor.commands.insertContent("!");
    expect(outlinePluginKey.getState(editor.state)).toBe(before);
  });

  it("computes the outline without the extension installed", () => {
    const editor = new Editor({
      extensions: createRichTextPreset(),
      content: "<h2>Only</h2>",
    });
    editors.push(editor);
    expect(computeOutline(editor.state.doc)).toEqual([
      expect.objectContaining({ text: "Only", level: 2, id: "outline-0" }),
    ]);
    // No ids are added to headings unless Outline is enabled.
    expect(editor.getHTML()).not.toContain("id=");
  });

  it("tracks the active heading and focuses headings by id", () => {
    const editor = createEditor(
      '<h1 id="a">A</h1><p>one</p><h2 id="b">B</h2><p>two</p>',
    );
    select(editor, posOf(editor, "two"));
    expect(getActiveHeading(editor)?.id).toBe("b");
    select(editor, posOf(editor, "one"));
    expect(getActiveHeading(editor)?.id).toBe("a");

    expect(editor.commands.focusHeading("b")).toBe(true);
    expect(getActiveHeading(editor)?.id).toBe("b");
    expect(editor.state.selection.$from.parent.textContent).toBe("B");
    expect(editor.commands.focusHeading("missing")).toBe(false);
    expect(editor.commands.scrollToHeading("a")).toBe(true);

    expect(navigateToHeading(editor, { id: "a", pos: 0 })).toBe(true);
    expect(getActiveHeading(editor)?.id).toBe("a");
  });

  it("outline store notifies only when the outline or active heading changes", () => {
    const editor = createEditor('<h1 id="a">A</h1><p>one two</p><h2 id="b">B</h2>');
    const store = createOutlineStore(editor);
    let calls = 0;
    store.subscribe(() => calls++);
    const first = store.getSnapshot();
    expect(first.headings.map((h) => h.id)).toEqual(["a", "b"]);
    expect(first.tree).toHaveLength(1);

    select(editor, posOf(editor, "one"));
    select(editor, posOf(editor, "two"));
    expect(calls).toBe(0);
    expect(store.getSnapshot()).toBe(first);

    editor.commands.focusHeading("b");
    expect(calls).toBe(1);
    expect(store.getSnapshot().activeId).toBe("b");

    store.destroy();
    editor.commands.focusHeading("a");
    expect(calls).toBe(1);
  });
});

describe("TableOfContents", () => {
  it("renders linked entries and refreshes on heading changes", () => {
    const editor = createEditor(
      '<p>start</p><h1 id="a">Alpha</h1><h2 id="b">Beta</h2><h4 id="c">Too deep</h4>',
    );
    select(editor, 1);
    editor.commands.insertTableOfContents();
    let html = editor.getHTML();
    expect(html).toContain('data-type="table-of-contents"');
    expect(html).toContain('<a href="#a" data-heading-id="a">Alpha</a>');
    expect(html).toContain('<a href="#b" data-heading-id="b">Beta</a>');
    expect(html.slice(0, html.indexOf("</nav>"))).not.toContain("Too deep");

    select(editor, posOf(editor, "Beta", 4));
    editor.commands.insertContent(" two");
    html = editor.getHTML();
    expect(html).toContain(">Beta two</a>");

    editor.commands.undo();
    expect(editor.getHTML()).toContain(">Beta</a>");
  });

  it("serializes to and parses from [[toc]] markdown", () => {
    const editor = createEditor("[[toc]]\n\n# One\n\n## Two", { markdown: true });
    const toc = editor.state.doc.firstChild!;
    expect(toc.type.name).toBe("tableOfContents");
    expect(toc.attrs.entries.map((e: any) => e.text)).toEqual(["One", "Two"]);
    const md = getEditorMarkdown(editor);
    expect(md).toContain("[[toc]]");
    expect(md).toContain("# One");
  });

  it("builds entries limited to a level range", () => {
    const entries = getTableOfContentsEntries(
      [
        { id: "a", level: 1, text: "A", pos: 0, index: 0, depth: 0 },
        { id: "b", level: 2, text: "B", pos: 3, index: 1, depth: 1 },
        { id: "c", level: 3, text: "C", pos: 6, index: 2, depth: 2 },
      ],
      2,
      3,
    );
    expect(entries).toEqual([
      { id: "b", level: 2, text: "B", depth: 0 },
      { id: "c", level: 3, text: "C", depth: 1 },
    ]);
  });

  it("navigates to a heading when an entry is clicked", () => {
    const editor = createEditor('<nav data-type="table-of-contents"></nav><p>x</p><h1 id="a">Alpha</h1>');
    const link = editor.view.dom.querySelector('a[data-heading-id="a"]') as HTMLElement;
    expect(link).toBeTruthy();
    link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.state.selection.$from.parent.textContent).toBe("Alpha");
  });
});

describe("Footnotes", () => {
  it("inserts numbered references with a footnotes list at the end", () => {
    const editor = createEditor("<p>First sentence. Second sentence.</p><p>Tail</p>");
    select(editor, posOf(editor, ". Second"));
    editor.commands.insertFootnote({ content: "Note one" });
    select(editor, posOf(editor, "First", 0));
    editor.commands.insertFootnote({ content: "Note zero" });

    const footnotes = getFootnotes(editor.state.doc);
    expect(footnotes.map((f) => [f.number, f.text])).toEqual([
      [1, "Note zero"],
      [2, "Note one"],
    ]);
    expect(editor.state.doc.lastChild!.type.name).toBe("footnotes");
    const html = editor.getHTML();
    expect(html).toMatch(/<sup[^>]*data-type="footnote-reference"[^>]*><a href="#fn-[^"]+">1<\/a><\/sup>First/);
    expect(html).toContain('<section data-type="footnotes"');
    expect(editor.getText()).toContain("[1]First");
  });

  it("moves the caret into a new empty footnote, like Word", () => {
    const editor = createEditor("<p>Body</p>");
    select(editor, posOf(editor, "Body", 4));
    editor.commands.insertFootnote();
    const { $from } = editor.state.selection;
    expect($from.node($from.depth - 1).type.name).toBe("footnote");
    editor.commands.insertContent("typed note");
    expect(getFootnotes(editor.state.doc)[0].text).toBe("typed note");
  });

  it("updates, deletes and renumbers footnotes, and undo restores them", () => {
    const editor = createEditor("<p>a b c</p>");
    select(editor, posOf(editor, " b"));
    editor.commands.insertFootnote({ content: "A" });
    select(editor, posOf(editor, " c"));
    editor.commands.insertFootnote({ content: "B" });
    const [first, second] = getFootnotes(editor.state.doc);

    expect(editor.commands.updateFootnote(second.id, "B edited")).toBe(true);
    expect(getFootnotes(editor.state.doc)[1].text).toBe("B edited");

    expect(editor.commands.deleteFootnote(first.id)).toBe(true);
    let notes = getFootnotes(editor.state.doc);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: second.id, number: 1, text: "B edited" });

    // Deleting the reference by hand removes its footnote too.
    const ref = notes[0].referencePos;
    editor.view.dispatch(editor.state.tr.delete(ref, ref + 1));
    expect(getFootnotes(editor.state.doc)).toHaveLength(0);
    expect(editor.state.doc.lastChild!.type.name).toBe("paragraph");

    editor.commands.undo();
    notes = getFootnotes(editor.state.doc);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("B edited");
  });

  it("renumbers when references are reordered", () => {
    const editor = createEditor("<p>x</p><p>y</p>");
    select(editor, posOf(editor, "x", 1));
    editor.commands.insertFootnote({ content: "X" });
    select(editor, posOf(editor, "y", 1));
    editor.commands.insertFootnote({ content: "Y" });
    // Move the first paragraph (with its reference) after the second.
    const firstPara = editor.state.doc.child(0);
    const tr = editor.state.tr.delete(0, firstPara.nodeSize);
    tr.insert(tr.doc.child(0).nodeSize, firstPara);
    editor.view.dispatch(tr);
    expect(getFootnotes(editor.state.doc).map((f) => [f.number, f.text])).toEqual([
      [1, "Y"],
      [2, "X"],
    ]);
    const list = editor.state.doc.lastChild!;
    expect(list.child(0).textContent).toBe("Y");
    expect(list.child(0).attrs.number).toBe(1);
  });

  it("gives a pasted copy of a reference its own footnote", () => {
    const editor = createEditor("<p>one two</p>");
    select(editor, posOf(editor, " two"));
    editor.commands.insertFootnote({ content: "Original" });
    const [note] = getFootnotes(editor.state.doc);
    const refNode = editor.state.doc.nodeAt(note.referencePos)!;
    select(editor, posOf(editor, "two", 3));
    editor.view.dispatch(editor.state.tr.replaceSelectionWith(refNode, false));
    const notes = getFootnotes(editor.state.doc);
    expect(notes).toHaveLength(2);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(notes[1].text).toBe("Original");
  });

  it("does not insert footnotes inside footnotes", () => {
    const editor = createEditor("<p>Body</p>");
    select(editor, posOf(editor, "Body", 4));
    editor.commands.insertFootnote();
    expect(editor.commands.insertFootnote()).toBe(false);
  });

  it("navigates between references and footnotes", () => {
    const editor = createEditor("<p>Body</p>");
    select(editor, posOf(editor, "Body", 4));
    editor.commands.insertFootnote({ content: "Note" });
    const [note] = getFootnotes(editor.state.doc);
    expect(editor.commands.goToFootnote(note.id)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("Note");
    expect(editor.commands.goToFootnoteReference(note.id)).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("footnoteReference");
  });

  it("exports markdown footnotes and imports them back", () => {
    const editor = createEditor("<p>Body text</p>", { markdown: true });
    select(editor, posOf(editor, "Body", 4));
    editor.commands.insertFootnote({ content: "A note" });
    select(editor, posOf(editor, "text", 4));
    editor.commands.insertFootnote({ content: "Second\n\nwith two paragraphs" });
    const md = getEditorMarkdown(editor);
    expect(md).toBe(
      "Body[^1] text[^2]\n\n[^1]: A note\n\n[^2]: Second\n\n    with two paragraphs",
    );

    const reloaded = createEditor(md, { markdown: true });
    const notes = getFootnotes(reloaded.state.doc);
    expect(notes.map((f) => [f.number, f.text])).toEqual([
      [1, "A note"],
      [2, "Second\n\nwith two paragraphs"],
    ]);
    expect(reloaded.state.doc.lastChild!.type.name).toBe("footnotes");
    expect(getEditorMarkdown(reloaded)).toBe(md);
  });

  it("imports markdown definitions in any order and drops unused ones", () => {
    const editor = createEditor(
      "[^b]: Bee\n\nSee[^a] and[^b].\n\n[^a]: Ay\n\n[^unused]: Nope",
      { markdown: true },
    );
    expect(getFootnotes(editor.state.doc).map((f) => [f.id, f.number, f.text])).toEqual([
      ["a", 1, "Ay"],
      ["b", 2, "Bee"],
    ]);
    expect(editor.getText()).not.toContain("Nope");
  });
});

describe("Bookmarks and cross-references", () => {
  it("bookmarks a selection or the word at the caret", () => {
    const editor = createEditor("<p>The quick brown fox</p>");
    const from = posOf(editor, "quick");
    select(editor, from, from + 5);
    expect(editor.commands.setBookmark({ name: "speed" })).toBe(true);
    select(editor, posOf(editor, "fox", 1));
    expect(editor.commands.setBookmark({ name: "animal" })).toBe(true);
    expect(getBookmarks(editor.state.doc).map((b) => [b.name, b.text])).toEqual([
      ["speed", "quick"],
      ["animal", "fox"],
    ]);
    expect(editor.getHTML()).toContain('data-bookmark-name="speed"');

    // Setting an existing name moves the bookmark but keeps its id.
    const id = getBookmarks(editor.state.doc)[0].id;
    const brown = posOf(editor, "brown");
    select(editor, brown, brown + 5);
    editor.commands.setBookmark({ name: "speed" });
    const moved = getBookmarks(editor.state.doc).find((b) => b.name === "speed")!;
    expect(moved).toMatchObject({ id, text: "brown" });

    expect(editor.commands.renameBookmark(id, "colour")).toBe(true);
    expect(getBookmarks(editor.state.doc).find((b) => b.id === id)!.name).toBe("colour");
    expect(editor.commands.goToBookmark(id)).toBe(true);
    const { from: selFrom, to: selTo } = editor.state.selection;
    expect(editor.state.doc.textBetween(selFrom, selTo)).toBe("brown");
    expect(editor.commands.removeBookmark(id)).toBe(true);
    expect(getBookmarks(editor.state.doc).map((b) => b.name)).toEqual(["animal"]);
  });

  it("does not bookmark an empty selection outside a word", () => {
    const editor = createEditor("<p></p>");
    expect(editor.commands.setBookmark({ name: "x" })).toBe(false);
  });

  it("cross-references show the current bookmark text and break when it is removed", () => {
    const editor = createEditor("<p>Price: 10 dollars</p><p>See:</p>");
    const ten = posOf(editor, "10");
    select(editor, ten, ten + 2);
    editor.commands.setBookmark({ name: "price" });
    const [bookmark] = getBookmarks(editor.state.doc);
    select(editor, posOf(editor, "See:", 4));
    expect(
      editor.commands.insertCrossReference({ targetType: "bookmark", targetId: bookmark.id }),
    ).toBe(true);
    expect(editor.getText()).toContain("See:10");

    // Editing the bookmarked text updates the reference.
    select(editor, posOf(editor, "10", 1));
    editor.commands.insertContent("5");
    expect(editor.getText()).toContain("See:150");

    editor.commands.removeBookmark(bookmark.id);
    expect(editor.getHTML()).toContain("is-broken");
    expect(editor.getText()).toContain("Error! Reference source not found.");

    editor.commands.undo();
    expect(editor.getHTML()).not.toContain("is-broken");
    expect(editor.getText()).toContain("See:150");
  });

  it("cross-references follow heading renames and deletion", () => {
    const editor = createEditor('<h2 id="h">Results</h2><p>As shown in</p>');
    select(editor, posOf(editor, "shown in", 8));
    editor.commands.insertCrossReference({ targetType: "heading", targetId: "h" });
    expect(editor.getHTML()).toContain('<a data-target-type="heading" data-target-id="h"');
    expect(editor.getHTML()).toContain('href="#h"');

    select(editor, posOf(editor, "Results", 7));
    editor.commands.insertContent(" 2024");
    expect(editor.getText()).toContain("As shown inResults 2024");

    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
    expect(editor.getHTML()).toContain("is-broken");

    expect(editor.commands.insertCrossReference({ targetType: "heading", targetId: "nope" })).toBe(false);
  });

  it("follows a cross-reference to its target", () => {
    const editor = createEditor('<h2 id="h">Target</h2><p>Go:</p>');
    select(editor, posOf(editor, "Go:", 3));
    editor.commands.insertCrossReference({ targetType: "heading", targetId: "h" });
    let xrefPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "crossReference") xrefPos = pos;
    });
    expect(editor.commands.followCrossReference(xrefPos)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("Target");
  });

  it("re-points heading references by text after ids are lost", () => {
    const editor = createEditor(
      '<h2>Methods</h2><p><a data-type="cross-reference" data-target-type="heading" data-target-id="gone" data-label="Methods">Methods</a></p>',
    );
    const headingId = getOutline(editor)[0].id;
    let attrs: any = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "crossReference") attrs = node.attrs;
    });
    expect(attrs).toMatchObject({ targetId: headingId, broken: false });
  });

  it("round-trips every structure node through getHTML", () => {
    const editor = createEditor('<h1 id="a">Head</h1><p>See the word here</p>');
    editor.commands.insertTableOfContents();
    const word = posOf(editor, "word");
    select(editor, word, word + 4);
    editor.commands.setBookmark({ name: "w" });
    select(editor, posOf(editor, "here", 4));
    editor.commands.insertCrossReference({ targetType: "heading", targetId: "a" });
    editor.commands.insertFootnote({ content: "Note" });
    const html = editor.getHTML();

    const copy = createEditor(html);
    const types = new Set<string>();
    copy.state.doc.descendants((node) => {
      types.add(node.type.name);
      node.marks.forEach((m) => types.add(m.type.name));
    });
    for (const name of [
      "tableOfContents",
      "bookmark",
      "crossReference",
      "footnoteReference",
      "footnotes",
      "footnote",
    ]) {
      expect(types).toContain(name);
    }
    // The cross-reference link is not mistaken for a Link mark.
    expect(types).not.toContain("link");
    expect(copy.getHTML()).toBe(html);
  });

  it("keeps bookmarks and cross-references through markdown as inline HTML", () => {
    const editor = createEditor("# Head\n\nSee the word here", { markdown: true });
    const word = posOf(editor, "word");
    select(editor, word, word + 4);
    editor.commands.setBookmark({ name: "w" });
    const [bookmark] = getBookmarks(editor.state.doc);
    select(editor, posOf(editor, "here", 4));
    editor.commands.insertCrossReference({ targetType: "heading", targetId: getOutline(editor)[0].id });
    editor.commands.insertCrossReference({ targetType: "bookmark", targetId: bookmark.id });
    const md = getEditorMarkdown(editor);
    expect(md).toContain('data-type="cross-reference"');

    // Heading ids are not part of markdown, so the heading reference is
    // re-pointed by its text; the bookmark keeps its id.
    const copy = createEditor(md, { markdown: true });
    expect(getBookmarks(copy.state.doc)[0]).toMatchObject({ id: bookmark.id, text: "word" });
    const refs: any[] = [];
    copy.state.doc.descendants((node) => {
      if (node.type.name === "crossReference") refs.push(node.attrs);
    });
    expect(refs.map((r) => [r.targetType, r.broken, r.label])).toEqual([
      ["heading", false, "Head"],
      ["bookmark", false, "word"],
    ]);
    expect(refs[0].targetId).toBe(getOutline(copy)[0].id);
  });

  it("lists cross-reference targets", () => {
    const editor = createEditor('<h1 id="a">Head</h1><p><span data-bookmark-id="b1" data-bookmark-name="bm">marked</span></p>');
    expect(getCrossReferenceTargets(editor.state.doc)).toEqual([
      { type: "heading", id: "a", text: "Head", name: "Head", level: 1 },
      { type: "bookmark", id: "b1", text: "marked", name: "bm" },
    ]);
  });
});

describe("Document-structure command items and preset", () => {
  it("leaves the default preset unchanged", () => {
    const names = createRichTextPreset().map((e: any) => e.name);
    for (const name of [
      "outline",
      "tableOfContents",
      "footnoteReference",
      "bookmark",
      "crossReference",
      "autocorrect",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("typography");
  });

  it("enables outline automatically for TOC and cross-references", () => {
    const names = createRichTextPreset({ tableOfContents: true }).map((e: any) => e.name);
    expect(names).toContain("outline");
    expect(names).toContain("tableOfContents");
  });

  it("lists only items for installed extensions and filters by query", () => {
    const editor = new Editor({
      extensions: createRichTextPreset({ footnotes: true }),
      content: "<p>x</p>",
    });
    editors.push(editor);
    expect(getDocumentStructureCommandItems(editor).map((i) => i.id)).toEqual(["footnote"]);
    expect(getDocumentStructureCommandItems(editor, "toc")).toEqual([]);
    expect(documentStructureCommandItems).toHaveLength(4);
  });

  it("runs items, deleting the slash-command range first", () => {
    const editor = createEditor("<p>/toc</p><h1>Heading</h1>");
    const [item] = getDocumentStructureCommandItems(editor, "toc");
    expect(item.id).toBe("table-of-contents");
    expect(item.run(editor, { range: { from: 1, to: 5 } })).toBe(true);
    expect(editor.getText()).not.toContain("/toc");
    expect(editor.getHTML()).toContain('data-type="table-of-contents"');

    const bookmark = getDocumentStructureCommandItems(editor, "bookmark")[0];
    expect(bookmark.requires).toBe("name");
    expect(bookmark.run(editor)).toBe(false);
  });
});
