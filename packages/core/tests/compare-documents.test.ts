import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor, getSchema } from "@tiptap/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import {
  BLOCK_CHANGE_ATTRIBUTE,
  DocumentCompare,
  TrackChanges,
  applyDocumentComparison,
  compareDocuments,
  compareHtml,
  createRichTextPreset,
  getEditorText,
  getTrackedChanges,
  resolveTrackedChanges,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
});

const schema = getSchema(createRichTextPreset({ trackChanges: true }));
const reviewer = { id: "rev", name: "Reviewer" };

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const text = (value: string, marks?: string[]) => ({
  type: "text",
  text: value,
  ...(marks?.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const p = (...content: any[]) => ({
  type: "paragraph",
  ...(content.length ? { content: content.map((c) => (typeof c === "string" ? text(c) : c)) } : {}),
});
const h = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const list = (type: "bulletList" | "orderedList", ...items: string[]) => ({
  type,
  content: items.map((item) => ({ type: "listItem", content: [p(item)] })),
});
const doc = (...content: any[]) => schema.nodeFromJSON({ type: "doc", content });

function compare(a: ProsemirrorNode, b: ProsemirrorNode, options: Parameters<typeof compareDocuments>[2] = {}) {
  let id = 0;
  return compareDocuments(a, b, { author: reviewer, date: 42, generateId: () => `c${++id}`, ...options });
}

function expectRoundTrip(a: ProsemirrorNode, b: ProsemirrorNode, result = compare(a, b)) {
  expect(resolveTrackedChanges(result.doc, "accepted").toJSON()).toEqual(b.toJSON());
  expect(resolveTrackedChanges(result.doc, "original").toJSON()).toEqual(a.toJSON());
}

const describeChanges = (node: ProsemirrorNode) =>
  getTrackedChanges(node).map((c) => [c.type, c.type === "block" || c.type === "format" ? c.description : c.text]);

describe("compareDocuments", () => {
  it("returns the document unchanged when both versions are equal", () => {
    const a = doc(p("Same words."), h(2, "Title"));
    const { doc: result, summary } = compare(a, a);
    expect(result.toJSON()).toEqual(a.toJSON());
    expect(summary).toEqual({ insertions: 0, deletions: 0, formatChanges: 0, blockChanges: 0, notHonoured: [] });
  });

  it("marks word-level changes inside a modified paragraph", () => {
    const a = doc(p("The cat sat."), p("Keep this."), p("Old line."));
    const b = doc(p("The dog sat."), p("Keep this."), p("New line here."));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([
      ["deletion", "cat"],
      ["insertion", "dog"],
      ["deletion", "Old"],
      ["insertion", "New"],
      ["insertion", " here"],
    ]);
    expect(result.doc.textContent).toBe("The catdog sat.Keep this.OldNew line here.");
    expect(result.summary).toMatchObject({ insertions: 3, deletions: 2, formatChanges: 0, blockChanges: 0 });
    const change = getTrackedChanges(result.doc)[0];
    expect(change.author).toEqual({ id: "rev", name: "Reviewer" });
    expect(change.createdAt).toBe(42);
    expectRoundTrip(a, b, result);
  });

  it("records inserted and deleted paragraphs as whole-block changes", () => {
    const a = doc(p("First."), p("Removed paragraph."), p("Last."));
    const b = doc(p("First."), p("Last."), p("Added at the end."));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([
      ["block", "Deleted Paragraph"],
      ["block", "Inserted Paragraph"],
    ]);
    const deleted = result.doc.child(1);
    expect(deleted.textContent).toBe("Removed paragraph.");
    expect(deleted.attrs[BLOCK_CHANGE_ATTRIBUTE]).toMatchObject({ operation: "delete", authorId: "rev" });
    expect(result.summary).toMatchObject({ insertions: 1, deletions: 1, blockChanges: 0 });
    expectRoundTrip(a, b, result);
  });

  it("joins replacements separated only by white space", () => {
    const result = compare(doc(p("one a b c two")), doc(p("one x y z two")));
    expect(describeChanges(result.doc)).toEqual([
      ["deletion", "a b c"],
      ["insertion", "x y z"],
    ]);
  });

  it("groups a run of inserted blocks into one change", () => {
    const a = doc(p("One."));
    const b = doc(p("One."), p("Two."), h(2, "Three"));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([["block", "Inserted 2 blocks"]]);
    expectRoundTrip(a, b, result);
  });

  it("records formatting differences of equal text", () => {
    const a = doc(p("Same words."));
    const b = doc(p(text("Same", ["bold"]), " words."));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([["format", "Formatted: Bold"]]);
    expect(result.summary.formatChanges).toBe(1);
    expectRoundTrip(a, b, result);
    expect(compare(a, b, { formatting: false }).summary.formatChanges).toBe(0);
  });

  it("records heading changes as block changes", () => {
    const a = doc(p("Introduction"), h(2, "Body"));
    const b = doc(h(1, "Introduction"), h(3, "Body"));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([
      ["block", "Changed Paragraph to Heading 1"],
      ["block", "Changed Heading 2 to Heading 3"],
    ]);
    expect(result.summary.blockChanges).toBe(2);
    expectRoundTrip(a, b, result);
  });

  it("compares list items and list type changes", () => {
    const a = doc(list("bulletList", "Apples", "Pears", "Plums"));
    const b = doc(list("orderedList", "Apples", "Green pears", "Cherries", "Plums"));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([
      ["block", "Changed Bulleted list to Numbered list"],
      ["deletion", "Pears"],
      ["insertion", "Green pears"],
      ["block", "Inserted Paragraph"],
    ]);
    // One change for the list type, covering every item.
    expect(getTrackedChanges(result.doc)[0].ranges).toHaveLength(3);
    expectRoundTrip(a, b, result);
  });

  it("deletes and inserts whole lists", () => {
    const a = doc(p("Intro"), list("bulletList", "One", "Two"), p("End"));
    const b = doc(p("Intro"), p("End"), list("orderedList", "Three"));
    expectRoundTrip(a, b);
  });

  it("compares by character at char granularity", () => {
    const a = doc(p("colour"));
    const b = doc(p("color"));
    const result = compare(a, b, { granularity: "char" });
    expect(describeChanges(result.doc)).toEqual([["deletion", "u"]]);
    expectRoundTrip(a, b, result);
    const long = compare(a, b, { granularity: "char", maxCharDiff: 3 });
    expect(describeChanges(long.doc)).toEqual([
      ["deletion", "colour"],
      ["insertion", "color"],
    ]);
    expect(long.summary.notHonoured.join(" ")).toMatch(/compared by words/);
  });

  it("ignores case and white space when asked, keeping the revised text", () => {
    const a = doc(p("The Cat sat."), p("Two  spaces here."));
    const b = doc(p("The cat sat."), p("Two spaces here."));
    expect(compare(a, b).summary.insertions + compare(a, b).summary.deletions).toBeGreaterThanOrEqual(2);
    const result = compare(a, b, { ignoreCase: true, ignoreWhitespace: true });
    expect(getTrackedChanges(result.doc)).toHaveLength(0);
    expect(result.doc.toJSON()).toEqual(b.toJSON());
  });

  it("replaces code blocks whole when the schema cannot mark code", () => {
    const code = (value: string) => ({ type: "codeBlock", content: [text(value)] });
    const a = doc(code("let a = 1;"));
    const b = doc(code("let a = 2;"));
    const result = compare(a, b);
    expect(describeChanges(result.doc)).toEqual([
      ["block", "Deleted Code block"],
      ["block", "Inserted Code block"],
    ]);
    expectRoundTrip(a, b, result);
  });

  it("reports differences it cannot track", () => {
    const image = { type: "image", attrs: { src: "a.png" } };
    const a = doc(p("Text"));
    const b = doc(p("Text"), image);
    const result = compare(a, b);
    expect(result.summary.notHonoured).toEqual(["Inserted image blocks cannot be tracked."]);
  });

  it("accepts tracked changes already in the inputs", () => {
    const ins = { type: "insertion", attrs: { changeId: "x", authorId: "a", authorName: "A", createdAt: 1 } };
    const a = doc(p({ type: "text", text: "Hello", marks: [ins] }));
    const result = compare(a, doc(p("Hello")));
    expect(getTrackedChanges(result.doc)).toHaveLength(0);
    expect(result.summary.notHonoured[0]).toMatch(/accepted before comparing/);
  });

  it("requires a schema for JSON sources and the track-changes marks", () => {
    expect(() => compareDocuments({ type: "doc" }, { type: "doc" })).toThrow(/schema/);
    const plain = getSchema(createRichTextPreset());
    expect(() => compareDocuments({ type: "doc", content: [p("a")] }, { type: "doc", content: [p("b")] }, { schema: plain })).toThrow(
      /TrackChanges/,
    );
  });

  it("compares HTML", () => {
    const result = compareHtml("<p>Hello world</p>", "<p>Hello <strong>brave</strong> world</p>", { schema, author: reviewer });
    expect(describeChanges(result.doc)).toEqual([["insertion", "brave "]]);
  });

  it("accept-all yields the revised and reject-all the original document (random edits)", () => {
    const random = rng(2026);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const vocabulary = ["alpha", "beta", "gamma", "delta", "Echo", "fox", "golf", "hotel", "india", "joy", "kilo", "lima"];
    type Word = { text: string; marks: string[] };
    type Block =
      | { kind: "paragraph" | "heading"; level: number; words: Word[] }
      | { kind: "bulletList" | "orderedList"; items: Word[][] }
      | { kind: "blockquote"; paragraphs: Word[][] };
    const words = (): Word[] =>
      Array.from({ length: Math.floor(random() * 6) }, () => ({
        text: pick(vocabulary),
        marks: random() < 0.2 ? [pick(["bold", "italic"])] : [],
      }));
    const block = (): Block => {
      const roll = random();
      if (roll < 0.5) return { kind: "paragraph", level: 1, words: words() };
      if (roll < 0.65) return { kind: "heading", level: 1 + Math.floor(random() * 3), words: words() };
      if (roll < 0.85) return { kind: pick(["bulletList", "orderedList"] as const), items: Array.from({ length: 1 + Math.floor(random() * 3) }, words) };
      return { kind: "blockquote", paragraphs: Array.from({ length: 1 + Math.floor(random() * 2) }, words) };
    };
    const inline = (list: Word[]) =>
      list.map((w, i) => text(i < list.length - 1 ? `${w.text} ` : w.text, w.marks)).filter((t) => t.text);
    const para = (list: Word[]) => p(...inline(list));
    const toJSON = (blocks: Block[]) => ({
      type: "doc",
      content: blocks.map((b) => {
        switch (b.kind) {
          case "paragraph":
            return para(b.words);
          case "heading":
            return { type: "heading", attrs: { level: b.level }, content: inline(b.words) };
          case "blockquote":
            return { type: "blockquote", content: b.paragraphs.map(para) };
          default:
            return { type: b.kind, content: b.items.map((item) => ({ type: "listItem", content: [para(item)] })) };
        }
      }),
    });
    const editWords = (list: Word[]): Word[] => {
      const copy = list.map((w) => ({ ...w, marks: [...w.marks] }));
      const roll = random();
      const at = Math.floor(random() * (copy.length + 1));
      if (roll < 0.3) copy.splice(at, 0, { text: pick(vocabulary), marks: [] });
      else if (roll < 0.55 && copy.length) copy.splice(Math.min(at, copy.length - 1), 1);
      else if (roll < 0.75 && copy.length) copy[Math.min(at, copy.length - 1)].text = pick(vocabulary);
      else if (copy.length) {
        const w = copy[Math.min(at, copy.length - 1)];
        w.marks = w.marks.includes("bold") ? [] : ["bold"];
      }
      return copy;
    };
    const edit = (blocks: Block[]): Block[] => {
      const copy: Block[] = JSON.parse(JSON.stringify(blocks));
      const index = Math.floor(random() * copy.length);
      const target = copy[index];
      const roll = random();
      if (roll < 0.15) copy.splice(Math.floor(random() * (copy.length + 1)), 0, block());
      else if (roll < 0.28 && copy.length > 1) copy.splice(index, 1);
      else if (roll < 0.38 && (target.kind === "paragraph" || target.kind === "heading")) {
        copy[index] = target.kind === "paragraph" ? { ...target, kind: "heading", level: 2 } : { ...target, kind: "paragraph", level: 1 };
      } else if (target.kind === "paragraph" || target.kind === "heading") {
        target.words = editWords(target.words);
      } else if (target.kind === "blockquote") {
        const i = Math.floor(random() * target.paragraphs.length);
        target.paragraphs[i] = editWords(target.paragraphs[i]);
      } else {
        const r = random();
        if (r < 0.2) target.kind = target.kind === "bulletList" ? "orderedList" : "bulletList";
        else if (r < 0.4) target.items.splice(Math.floor(random() * (target.items.length + 1)), 0, words());
        else if (r < 0.55 && target.items.length > 1) target.items.splice(Math.floor(random() * target.items.length), 1);
        else {
          const i = Math.floor(random() * target.items.length);
          target.items[i] = editWords(target.items[i]);
        }
      }
      return copy;
    };

    const seen = { insertions: 0, deletions: 0, formatChanges: 0, blockChanges: 0 };
    for (let round = 0; round < 300; round++) {
      const original = Array.from({ length: 1 + Math.floor(random() * 5) }, block);
      let revised = original;
      const edits = 1 + Math.floor(random() * 5);
      for (let e = 0; e < edits; e++) revised = edit(revised);
      const a = schema.nodeFromJSON(toJSON(original));
      const b = schema.nodeFromJSON(toJSON(revised));
      const granularity = random() < 0.3 ? "char" : "word";
      const result = compare(a, b, { granularity });
      for (const key of Object.keys(seen) as (keyof typeof seen)[]) seen[key] += result.summary[key];
      try {
        expectRoundTrip(a, b, result);
        expect(result.summary.notHonoured).toEqual([]);
      } catch (error) {
        throw new Error(
          `round ${round} (${granularity})\noriginal: ${JSON.stringify(toJSON(original))}\nrevised: ${JSON.stringify(toJSON(revised))}\n${(error as Error).message}`,
        );
      }
    }
    // Every kind of change was exercised.
    expect(Object.values(seen).every((count) => count > 10)).toBe(true);
  });
});

describe("document comparison in an editor", () => {
  function createEditor(content = "<p>Draft</p>") {
    return new Editor({
      extensions: [
        ...createRichTextPreset(),
        TrackChanges.configure({ enabled: true, author: reviewer }),
        DocumentCompare,
      ],
      content,
    });
  }

  it("setContentFromComparison sets tracked content without re-tracking it", () => {
    const editor = createEditor();
    editor.commands.setContentFromComparison("<p>The cat sat.</p>", "<p>The dog sat.</p>");
    const changes = getTrackedChanges(editor.state.doc);
    expect(changes.map((c) => [c.type, c.text, c.author.id])).toEqual([
      ["deletion", "cat", "rev"],
      ["insertion", "dog", "rev"],
    ]);
    expect(editor.storage.documentCompare.lastResult.summary).toMatchObject({ insertions: 1, deletions: 1 });
    editor.commands.acceptAllChanges();
    expect(editor.getText()).toBe("The dog sat.");
    editor.destroy();
  });

  it("rejecting all restores the original, including deleted and inserted blocks", () => {
    const editor = createEditor();
    applyDocumentComparison(editor, "<p>Keep</p><p>Gone</p><ul><li><p>Item</p></li></ul>", "<h2>Keep</h2><p>New</p>");
    expect(getTrackedChanges(editor.state.doc).map((c) => c.description)).toEqual([
      "Changed Paragraph to Heading 2",
      'Deleted "Gone"',
      'Inserted "New"',
      "Deleted Paragraph",
    ]);
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe('<p>Keep</p><p>Gone</p><ul class="list-disc pl-4"><li><p>Item</p></li></ul>');
    editor.destroy();
  });

  it("compares inside code blocks when the editor allows tracking there", () => {
    const editor = createEditor();
    applyDocumentComparison(editor, "<pre><code>let a = 1;</code></pre>", "<pre><code>let a = 2;</code></pre>");
    expect(describeChanges(editor.state.doc)).toEqual([
      ["deletion", "1"],
      ["insertion", "2"],
    ]);
    editor.destroy();
  });

  it("keeps whole-block records when the block is edited later", () => {
    const editor = createEditor();
    applyDocumentComparison(editor, "<p>One</p>", "<p>One</p><p>Two</p>");
    const pos = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection(pos + 2);
    editor.commands.setNode("heading", { level: 2 });
    const record = editor.state.doc.child(1).attrs[BLOCK_CHANGE_ATTRIBUTE];
    expect(record?.operation).toBe("insert");
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe("<p>One</p>");
    editor.destroy();
  });

  it("accepts and rejects single whole-block changes by id", () => {
    const editor = createEditor();
    applyDocumentComparison(editor, "<p>Keep</p><ul><li><p>Old item</p></li></ul>", "<p>Keep</p><blockquote><p>Quote</p></blockquote>");
    const [deleted, inserted] = getTrackedChanges(editor.state.doc);
    expect([deleted.description, inserted.description]).toEqual(["Deleted Paragraph", "Inserted Paragraph"]);
    // Exports drop whole-block changes like inline ones.
    expect(getEditorText(editor, { trackedChanges: "original" })).toBe("Keep\nOld item");
    expect(getEditorText(editor)).toBe("Keep\nQuote");
    editor.commands.acceptChange(deleted.id);
    const types: string[] = [];
    editor.state.doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(["paragraph", "blockquote"]);
    editor.commands.rejectChange(inserted.id);
    expect(editor.getHTML()).toBe("<p>Keep</p>");
    editor.destroy();
  });

  it("renders inserted and deleted blocks with their classes", () => {
    const editor = createEditor();
    applyDocumentComparison(editor, "<p>Old</p>", "<p>Brand new paragraph</p><h2>Extra</h2>");
    const html = editor.getHTML();
    expect(html).toContain('data-block-operation="insert"');
    expect(html).toContain("pixerate-block-inserted");
    editor.destroy();
  });
});
