// Behaviour re-expressed from wordcraft's crates/engine/src/cmd/moves.rs tests
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  TrackChanges,
  createRichTextPreset,
  getEditorText,
  getTrackedChanges,
  htmlToPlainText,
  isMoveSized,
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
  content = "<p>First one.</p><p>Second one.</p><p>Third one.</p>",
  options: Partial<Parameters<typeof TrackChanges.configure>[0]> = {},
) {
  let id = 0;
  return new Editor({
    extensions: [
      ...createRichTextPreset(),
      TrackChanges.configure({
        enabled: true,
        author: alice,
        generateId: () => `ch-${++id}`,
        now: () => 42,
        ...options,
      }),
    ],
    content,
  });
}

/** Positions of the start of each top-level block's content. */
function blockStart(editor: Editor, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos + 1;
}

function select(editor: Editor, from: number, to: number) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

/** Cuts the selection like ProseMirror's cut handler; returns the clipboard HTML. */
function cut(editor: Editor): string {
  const slice = editor.state.selection.content();
  const html = (editor.view as any).serializeForClipboard(slice).dom.innerHTML as string;
  editor.view.dispatch(editor.state.tr.deleteSelection().setMeta("uiEvent", "cut"));
  return html;
}

function paste(editor: Editor, at: number, html: string) {
  select(editor, at, at);
  editor.view.pasteHTML(html);
}

/** Drags the selection to `target` (a position in the current document), like ProseMirror's drop handler. */
function dragMove(editor: Editor, target: number) {
  const slice = editor.state.selection.content();
  const tr = editor.state.tr;
  tr.deleteSelection();
  const pos = tr.mapping.map(target);
  tr.replaceRange(pos, pos, slice);
  editor.view.dispatch(tr.setMeta("uiEvent", "drop"));
}

const texts = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.textContent));
  return out;
};

/** Moves the second paragraph (with its paragraph break) before the first. */
function moveParagraph(editor: Editor) {
  select(editor, blockStart(editor, 1), blockStart(editor, 2));
  const html = cut(editor);
  paste(editor, blockStart(editor, 0), html);
}

describe("isMoveSized", () => {
  it("accepts paragraphs and sentences of two or more words", () => {
    expect(isMoveSized("Second one.\n")).toBe(true);
    expect(isMoveSized("Two words.")).toBe(true);
    expect(isMoveSized('He said "go now!"')).toBe(true);
    expect(isMoveSized("one ")).toBe(false);
    expect(isMoveSized("Word.")).toBe(false);
    expect(isMoveSized("no full stop here")).toBe(false);
  });
});

describe("tracked moves", () => {
  it("records a tracked cut and paste of a paragraph as one move", () => {
    const editor = createEditor();
    moveParagraph(editor);
    expect(texts(editor)).toEqual(["Second one.", "First one.", "Second one.", "Third one."]);
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    const [move] = changes;
    expect(move.type).toBe("move");
    expect(move.description).toBe('Moved "Second one."');
    expect(move.author).toEqual(alice);
    expect(move.move!.fromText).toBe("Second one.");
    expect(move.move!.toText).toBe("Second one.");
    expect(move.move!.to[0].from).toBeLessThan(move.move!.from[0].from);
    expect(move.ranges).toHaveLength(2);
    // Both ends share the move id in the HTML, with distinct move styling.
    const html = editor.getHTML();
    expect(html).toContain(`data-move-id="${move.id}"`);
    expect(html).toMatch(/<ins[^>]*pixerate-move-to/);
    expect(html).toMatch(/<del[^>]*pixerate-move-from/);
    editor.destroy();
  });

  it("does not record a cut and paste of a single word as a move", () => {
    const editor = createEditor("<p>one two</p>");
    select(editor, 1, 5);
    const html = cut(editor);
    paste(editor, editor.state.doc.content.size - 1, html);
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["deletion", "insertion"]);
    editor.destroy();
  });

  it("records a word as a move when isMove allows it", () => {
    const editor = createEditor("<p>one two</p>", { isMove: () => true });
    select(editor, 1, 5);
    const html = cut(editor);
    paste(editor, editor.state.doc.content.size - 1, html);
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["move"]);
    editor.destroy();
  });

  it("does not link a paste of different text, or a paste after another edit", () => {
    const editor = createEditor();
    select(editor, blockStart(editor, 1), blockStart(editor, 2));
    cut(editor);
    paste(editor, blockStart(editor, 0), "<p>Something else entirely.</p>");
    expect(getTrackedChanges(editor).some((c) => c.type === "move")).toBe(false);
    editor.destroy();

    const other = createEditor();
    select(other, blockStart(other, 1), blockStart(other, 2));
    const html = cut(other);
    // Typing in between ends the cut-and-paste sequence.
    other.view.dispatch(other.state.tr.insertText("x", 1));
    paste(other, blockStart(other, 0), html);
    expect(getTrackedChanges(other).some((c) => c.type === "move")).toBe(false);
    other.destroy();
  });

  it("does not record moves when trackMoves is off", () => {
    const editor = createEditor(undefined, { trackMoves: false });
    moveParagraph(editor);
    expect(getTrackedChanges(editor).map((c) => c.type).sort()).toEqual(["deletion", "insertion"]);
    editor.destroy();
  });

  it("accepting a move removes the source and keeps the destination", () => {
    const editor = createEditor();
    moveParagraph(editor);
    const [move] = getTrackedChanges(editor);
    expect(editor.commands.acceptMove(move.id)).toBe(true);
    expect(texts(editor)).toEqual(["Second one.", "First one.", "Third one."]);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("rejecting a move restores the source and removes the destination", () => {
    const editor = createEditor();
    moveParagraph(editor);
    const [move] = getTrackedChanges(editor);
    expect(editor.commands.rejectMove(move.id)).toBe(true);
    expect(texts(editor)).toEqual(["First one.", "Second one.", "Third one."]);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("acceptChange / rejectChange and accept-all resolve both ends", () => {
    const editor = createEditor();
    moveParagraph(editor);
    const [move] = getTrackedChanges(editor);
    expect(editor.commands.rejectChange(move.id)).toBe(true);
    expect(texts(editor)).toEqual(["First one.", "Second one.", "Third one."]);
    editor.destroy();

    const other = createEditor();
    moveParagraph(other);
    other.commands.acceptAllChanges();
    expect(texts(other)).toEqual(["Second one.", "First one.", "Third one."]);
    other.destroy();
  });

  it("acceptMove ignores ids that are not moves", () => {
    const editor = createEditor("<p>one two</p>");
    select(editor, 1, 5);
    cut(editor);
    const [deletion] = getTrackedChanges(editor);
    expect(editor.commands.acceptMove(deletion.id)).toBe(false);
    expect(editor.commands.rejectMove("nope")).toBe(false);
    editor.destroy();
  });

  it("records a drag of a sentence within the document as a move", () => {
    const editor = createEditor("<p>Keep this. Move me now.</p><p>Target here</p>");
    const start = 1 + "Keep this. ".length;
    select(editor, start, start + "Move me now.".length);
    dragMove(editor, editor.state.doc.content.size - 1);
    const changes = getTrackedChanges(editor);
    expect(changes.map((c) => c.type)).toEqual(["move"]);
    expect(changes[0].move!.from).toHaveLength(1);
    expect(changes[0].move!.to).toHaveLength(1);
    editor.commands.acceptMove(changes[0].id);
    expect(texts(editor)).toEqual(["Keep this. ", "Target hereMove me now."]);
    editor.destroy();
  });

  it("rejecting a dragged move puts the text back", () => {
    const editor = createEditor("<p>Keep this. Move me now.</p><p>Target here</p>");
    const start = 1 + "Keep this. ".length;
    select(editor, start, start + "Move me now.".length);
    dragMove(editor, editor.state.doc.content.size - 1);
    editor.commands.rejectAllChanges();
    expect(texts(editor)).toEqual(["Keep this. Move me now.", "Target here"]);
    editor.destroy();
  });

  it("does not record a drag of a word as a move", () => {
    const editor = createEditor("<p>alpha beta</p><p>gamma</p>");
    select(editor, 1, 6);
    dragMove(editor, editor.state.doc.content.size - 1);
    expect(getTrackedChanges(editor).map((c) => c.type).sort()).toEqual(["deletion", "insertion"]);
    editor.destroy();
  });

  it("undoing the paste turns the move back into the cut's deletion; undoing again restores the text", () => {
    const editor = createEditor();
    moveParagraph(editor);
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["move"]);
    editor.commands.undo();
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["deletion"]);
    expect(editor.getHTML()).not.toContain("data-move-id");
    editor.commands.undo();
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(texts(editor)).toEqual(["First one.", "Second one.", "Third one."]);
    editor.destroy();
  });

  it("undoes a dragged move in one step", () => {
    const editor = createEditor("<p>Keep this. Move me now.</p><p>Target here</p>");
    const before = editor.getHTML();
    const start = 1 + "Keep this. ".length;
    select(editor, start, start + "Move me now.".length);
    dragMove(editor, editor.state.doc.content.size - 1);
    editor.commands.undo();
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it("typing next to moved text is a separate insertion", () => {
    const editor = createEditor("<p>Keep this. Move me now.</p><p>Target here</p>");
    const start = 1 + "Keep this. ".length;
    select(editor, start, start + "Move me now.".length);
    dragMove(editor, editor.state.doc.content.size - 1);
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.insertText("!", end));
    expect(getTrackedChanges(editor).map((c) => c.type)).toEqual(["move", "insertion"]);
    editor.destroy();
  });

  it("only links a paste by the author who cut", () => {
    const editor = createEditor();
    select(editor, blockStart(editor, 1), blockStart(editor, 2));
    const html = cut(editor);
    editor.commands.setTrackChangesAuthor(bob);
    paste(editor, blockStart(editor, 0), html);
    expect(getTrackedChanges(editor).some((c) => c.type === "move")).toBe(false);
    editor.destroy();
  });

  it("round-trips moves through HTML", () => {
    const editor = createEditor();
    moveParagraph(editor);
    const html = editor.getHTML();
    const copy = createEditor(html);
    const [move] = getTrackedChanges(copy);
    expect(move.type).toBe("move");
    expect(copy.getHTML()).toBe(html);
    copy.commands.rejectMove(move.id);
    expect(texts(copy)).toEqual(["First one.", "Second one.", "Third one."]);
    editor.destroy();
    copy.destroy();
  });

  it("exports moves like insertions and deletions in plain text", () => {
    const editor = createEditor();
    moveParagraph(editor);
    // With an editor, moved paragraphs are resolved with their blocks.
    expect(getEditorText(editor)).toBe("Second one.\nFirst one.\nThird one.");
    expect(getEditorText(editor, { trackedChanges: "original" })).toBe(
      "First one.\nSecond one.\nThird one.",
    );
    expect(getEditorText(editor, { trackedChanges: "all" })).toBe(
      "Second one.\nFirst one.\nSecond one.\nThird one.",
    );
    // From HTML alone, moves are stripped like insertions and deletions.
    expect(htmlToPlainText(editor.getHTML())).toBe("Second one.\nFirst one.\n\nThird one.");
    expect(htmlToPlainText(editor.getHTML(), { trackedChanges: "original" })).toBe(
      "\nFirst one.\nSecond one.\nThird one.",
    );
    const accepted = resolveTrackedChanges(editor.state.doc, "accepted");
    const lines: string[] = [];
    accepted.forEach((node) => lines.push(node.textContent));
    expect(lines).toEqual(["Second one.", "First one.", "Third one."]);
    editor.destroy();
  });

  it("selectNextChange selects the destination of a move", () => {
    const editor = createEditor();
    moveParagraph(editor);
    const [move] = getTrackedChanges(editor);
    select(editor, editor.state.doc.content.size - 1, editor.state.doc.content.size - 1);
    editor.commands.selectNextChange();
    expect(editor.state.selection.from).toBe(move.move!.to[0].from);
    editor.destroy();
  });
});
