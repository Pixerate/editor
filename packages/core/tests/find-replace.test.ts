// Scenarios re-expressed from wordcraft/crates/engine/src/tests.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { Editor, type JSONContent } from "@tiptap/core";
import {
  FindReplace,
  TrackChanges,
  compileFindPattern,
  createRichTextPreset,
  createSearchBudget,
  expandReplacement,
  findAllMatches,
  getEditorText,
  getFindReplaceState,
  getFindReplaceStore,
  getTrackedChanges,
  parseReplacement,
  searchDocument,
  validateFindPattern,
  createFindReplaceCommands,
  type FindOptions,
} from "../src";
import { createCommandRegistry } from "../src/commands";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  // ProseMirror measures layout when scrolling a selection into view; jsdom does not.
  dom.window.document.elementFromPoint = () => null;
  (dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
  (dom.window as any).Range.prototype.getClientRects = () => [];
  (dom.window as any).Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
});

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

const alice = { id: "alice", name: "Alice" };

/** A document of plain paragraphs (`\n` separates them; tabs survive, unlike HTML). */
function docOf(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

function createEditor(text = "", options: { tracking?: boolean } = {}) {
  let id = 0;
  const editor = new Editor({
    extensions: [
      ...createRichTextPreset({ findReplace: { getClipboardText: () => "CLIP" } }),
      TrackChanges.configure({
        enabled: false,
        author: alice,
        generateId: () => `ch-${++id}`,
        now: () => 42,
      }),
    ],
    content: docOf(text),
  });
  if (options.tracking) editor.commands.setTrackChanges(true);
  editors.push(editor);
  return editor;
}

const NO_OPTIONS: Required<FindOptions> = {
  matchCase: false,
  wholeWord: false,
  matchPrefix: false,
  matchSuffix: false,
  ignorePunctuation: false,
  ignoreWhitespace: false,
  wildcards: false,
  regex: false,
  literal: false,
};

const state = (editor: Editor) => getFindReplaceState(editor)!;

function find(editor: Editor, query: string, options: FindOptions = {}) {
  editor.commands.setSearch({ query, options: { ...NO_OPTIONS, ...options } });
  return state(editor);
}

const count = (editor: Editor, query: string, options: FindOptions = {}) => {
  const s = find(editor, query, options);
  if (s.error) throw new Error(s.error.message);
  return s.matches.length;
};

const ranges = (editor: Editor, query: string, options: FindOptions = {}) =>
  find(editor, query, options).matches.map((m) => [m.from, m.to]);

function replaceAll(editor: Editor, query: string, replacement: string, options: FindOptions = {}) {
  editor.commands.setSearch({ query, replacement, options: { ...NO_OPTIONS, ...options } });
  if (!editor.commands.replaceAll()) return 0;
  return state(editor).lastReplaceCount;
}

/** Paragraph texts including tracked-deleted text. */
const paragraphs = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.textContent));
  return out;
};
const text = (editor: Editor) => paragraphs(editor).join("\n");

/** Deletes `[a, b)` (offsets in the first paragraph) like a keystroke. */
function deleteRange(editor: Editor, a: number, b: number) {
  editor.view.dispatch(editor.state.tr.delete(a + 1, b + 1));
}

describe("find pattern compiler", () => {
  const all = (query: string, hay: string, options: FindOptions = {}) => {
    const compiled = compileFindPattern(query, options);
    if (!compiled.ok) throw new Error(compiled.error.message);
    return findAllMatches(compiled.pattern, hay).matches.map((m) => hay.slice(m.start, m.end));
  };

  it("matches case-insensitively by default, including non-ASCII letters", () => {
    expect(all("café", "CAFÉ Café cafe")).toEqual(["CAFÉ", "Café"]);
    expect(all("Café", "CAFÉ Café café", { matchCase: true })).toEqual(["Café"]);
  });

  it("treats Unicode letters as word characters for whole words", () => {
    expect(all("caf", "café caf", { wholeWord: true })).toEqual(["caf"]);
    expect(all("über", "Über über", { wholeWord: true, matchCase: true })).toEqual(["über"]);
  });

  it("supports ^ codes: ^? ^$ ^# ^w ^t ^l and numeric codes", () => {
    expect(all("a^?c", "abc a\rc")).toEqual(["abc"]);
    expect(all("^$^$", "1a2bc")).toEqual(["bc"]);
    expect(all("^#^#", "a12b3")).toEqual(["12"]);
    expect(all("a^wb", "a  \t b ab")).toEqual(["a  \t b"]);
    expect(all("^t", "x\ty")).toEqual(["\t"]);
    expect(all("^l", "x\ny")).toEqual(["\n"]);
    expect(all("^u8212", "a\u2014b")).toEqual(["\u2014"]);
    expect(all("^+", "a\u2014b")).toEqual(["\u2014"]);
    expect(all("^", "a^b")).toEqual(["^"]);
    expect(all("^#", "1^#", { literal: true })).toEqual(["^#"]);
  });

  it("ignores punctuation and white space between characters", () => {
    expect(all("eg", "e.g. eg", { ignorePunctuation: true })).toEqual(["e.g", "eg"]);
    expect(all("ab", "a b a\tb ab", { ignoreWhitespace: true })).toEqual(["a b", "a\tb", "ab"]);
    expect(all("a, b", "a b", { ignorePunctuation: true, ignoreWhitespace: true })).toEqual(["a b"]);
  });

  it("supports wildcards: ? * [ ] [! ] {n,m} @ < > and groups", () => {
    expect(all("b?d", "bad b?d", { wildcards: true })).toEqual(["bad", "b?d"]);
    expect(all("b?d", "bad b?d")).toEqual(["b?d"]);
    expect(all("<b*d>", "bad bread bud", { wildcards: true })).toEqual(["bad", "bread", "bud"]);
    expect(all("[a-c]{2}", "abz cc", { wildcards: true })).toEqual(["ab", "cc"]);
    expect(all("[!a-c]", "abz", { wildcards: true })).toEqual(["z"]);
    expect(all("lo@k", "lok look loooook", { wildcards: true })).toEqual(["lok", "look", "loooook"]);
    expect(all("10{2,}", "10 100 1000", { wildcards: true })).toEqual(["100", "1000"]);
    expect(all("x{,1}y", "xxy y", { wildcards: true })).toEqual(["xy", "y"]);
    expect(all("\\[", "a[b", { wildcards: true })).toEqual(["["]);
    // Wildcard search always matches case; * never crosses a paragraph mark.
    expect(all("Cat", "cat Cat", { wildcards: true })).toEqual(["Cat"]);
    expect(all("a*b", "a\rb ab", { wildcards: true })).toEqual(["ab"]);
  });

  it("steps past empty matches", () => {
    expect(all("x{0,1}", "axa", { wildcards: true })).toEqual(["x"]);
    expect(all("a*", "baab", { regex: true })).toEqual(["aa"]);
  });

  it("reports invalid patterns as structured errors", () => {
    for (const q of ["[z-a]", "a{5", "(ab", "ab)", "\\1", "x{2000}", "[", "@", "<@", "a@@", "*@", "[!]", "x{3,1}"]) {
      const result = compileFindPattern(q, { wildcards: true });
      expect(result.ok, q).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_pattern");
    }
    expect(validateFindPattern("x".repeat(2000))).toMatchObject({ code: "too_long" });
    expect(validateFindPattern("(a{1,1000}){1,1000}", { wildcards: true })).toMatchObject({ code: "too_complex" });
    expect(validateFindPattern("(a+)+b", { regex: true })).toMatchObject({ code: "too_complex" });
    expect(validateFindPattern("(\\w*)*", { regex: true })).toMatchObject({ code: "too_complex" });
    expect(validateFindPattern("(ab)+(c+)", { regex: true })).toBeNull();
    expect(validateFindPattern("([a+])+", { regex: true })).toBeNull();
    expect(validateFindPattern("(", { regex: true })).toMatchObject({ code: "invalid_pattern" });
    expect(validateFindPattern("plain")).toBeNull();
  });

  it("bounds hostile patterns: linear-time VM, step and time budgets, match cap", () => {
    const hay = "a".repeat(5000);
    const started = Date.now();
    for (const q of ["(a@)@b", "(*)@b", "(((((a*)*)*)*)*)b", "*a*a*a*b", "a{1,1000}a{1,1000}b"]) {
      const compiled = compileFindPattern(q, { wildcards: true });
      expect(compiled.ok, q).toBe(true);
      if (compiled.ok) expect(findAllMatches(compiled.pattern, hay).matches).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(10_000);

    const compiled = compileFindPattern("a");
    if (!compiled.ok) throw new Error();
    expect(findAllMatches(compiled.pattern, hay, { maxMatches: 10 })).toMatchObject({ truncated: true });
    expect(findAllMatches(compiled.pattern, hay, { maxMatches: 10 }).matches).toHaveLength(10);
    const spent = createSearchBudget({ timeLimitMs: -1 });
    expect(findAllMatches(compiled.pattern, hay, { budget: spent })).toMatchObject({ truncated: true });
    const fewSteps = createSearchBudget({ maxSteps: 100 });
    expect(findAllMatches(compiled.pattern, hay, { budget: fewSteps })).toMatchObject({ truncated: true });
  });

  it("parses and expands Replace with text", () => {
    const wild = parseReplacement("\\2 \\1^&^c^p^t^^\\x\\0", { wildcards: true });
    expect(wild).toEqual([
      { type: "group", index: 2 },
      { type: "text", text: " " },
      { type: "group", index: 1 },
      { type: "found" },
      { type: "clipboard" },
      { type: "text", text: "\r\t^x0" },
    ]);
    const match = { start: 0, end: 3, groups: ["a b", "a", "b"] };
    expect(expandReplacement(wild, match, "x\ny")).toBe("b aa bx\ry\r\t^x0");
    expect(parseReplacement("\\1", {})).toEqual([{ type: "text", text: "\\1" }]);
    expect(parseReplacement("^&", { regex: true })).toEqual([{ type: "text", text: "^&" }]);
    expect(parseReplacement("^&", { literal: true })).toEqual([{ type: "text", text: "^&" }]);
    expect(parseReplacement("^u8212^0", {})).toEqual([{ type: "text", text: "\u2014^0" }]);
  });

  it("never throws on odd Find and Replace text", () => {
    const editor = createEditor("a^b");
    for (const q of ["^", "^p^", "^u", "^99999999", "^0", "a^", "^u55296"]) {
      expect(() => replaceAll(editor, q, "^&^c\\9^p^")).not.toThrow();
    }
  });
});

describe("FindReplace extension", () => {
  it("is opt-in via createRichTextPreset", () => {
    expect(createRichTextPreset().some((e) => e.name === "findReplace")).toBe(false);
    expect(createRichTextPreset({ findReplace: true }).some((e) => e.name === "findReplace")).toBe(true);
  });

  it("finds and replaces (match case, regex)", () => {
    const editor = createEditor("cat dog cat\nCat bird");
    expect(count(editor, "cat")).toBe(3);
    expect(replaceAll(editor, "cat", "fox", { matchCase: true })).toBe(2);
    expect(text(editor)).toBe("fox dog fox\nCat bird");
    expect(count(editor, "\\b\\w{3}\\b", { regex: true })).toBe(4);
  });

  it("handles special codes: ^p across paragraphs, ^t, ^#, ^&, ^^ and literal mode", () => {
    const editor = createEditor("one\ntwo\nthree");
    expect(count(editor, "^p")).toBe(2);
    expect(replaceAll(editor, "o^pt", "O+T")).toBe(1);
    expect(paragraphs(editor)).toEqual(["one", "twO+Three"]);
    editor.commands.undo();
    expect(paragraphs(editor)).toEqual(["one", "two", "three"]);

    const split = createEditor("a, b, c");
    expect(replaceAll(split, ", ", "^p")).toBe(2);
    expect(paragraphs(split)).toEqual(["a", "b", "c"]);
    split.commands.undo();
    expect(paragraphs(split)).toEqual(["a, b, c"]);

    editor.commands.setContent(docOf("x\ty 12 a^b"));
    expect(replaceAll(editor, "^t", " ")).toBe(1);
    expect(replaceAll(editor, "^#", "<^&>")).toBe(2);
    expect(replaceAll(editor, "^^", "-")).toBe(1);
    expect(text(editor)).toBe("x y <1><2> a-b");
    expect(count(editor, "^#", { literal: true })).toBe(0);
  });

  it("supports wildcards with groups, anchors and counts, and the normal-search options", () => {
    const editor = createEditor("Smith, John and Doe, Jane; smith, x");
    expect(
      replaceAll(editor, "([A-Z][a-z]@), ([A-Z][a-z]@)", "\\2 \\1", { wildcards: true }),
    ).toBe(2);
    expect(text(editor)).toBe("John Smith and Jane Doe; smith, x");

    editor.commands.setContent(docOf("cat concat cats scatter"));
    expect(count(editor, "<cat", { wildcards: true })).toBe(2);
    expect(count(editor, "cat>", { wildcards: true })).toBe(2);
    expect(count(editor, "<c*t>", { wildcards: true })).toBe(2);
    expect(count(editor, "t{2}", { wildcards: true })).toBe(1);
    expect(count(editor, "[!c]at", { wildcards: true })).toBe(0);
    expect(count(editor, "[!s ]cat", { wildcards: true })).toBe(1);
    expect(count(editor, "cat", { matchPrefix: true })).toBe(2);
    expect(count(editor, "cat", { matchSuffix: true })).toBe(2);
    expect(count(editor, "cat", { wholeWord: true })).toBe(1);

    editor.commands.setContent(docOf("e.g. eg"));
    expect(count(editor, "eg", { ignorePunctuation: true, matchPrefix: true })).toBe(2);
  });

  it("reports invalid patterns in state instead of throwing", () => {
    const editor = createEditor("abc");
    expect(editor.commands.setSearch({ query: "[z-a]", options: { wildcards: true } })).toBe(true);
    expect(state(editor).error).toMatchObject({ code: "invalid_pattern" });
    expect(state(editor).matches).toEqual([]);
    expect(editor.commands.replaceAll()).toBe(false);
    expect(editor.commands.findNext()).toBe(false);
  });

  it("bounds hostile patterns in a long paragraph", () => {
    const editor = createEditor("a".repeat(5000));
    const started = Date.now();
    for (const q of ["(a@)@b", "(*)@b", "(a{1,1000}){1,1000}", "(((((a*)*)*)*)*)b"]) {
      expect(() => find(editor, q, { wildcards: true })).not.toThrow();
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    for (const q of ["[z-a]", "a{5", "(ab", "\\1", "x{2000}", "[", "@"]) {
      expect(find(editor, q, { wildcards: true }).error, q).not.toBeNull();
    }
    expect(find(editor, "x".repeat(2000)).error).toMatchObject({ code: "too_long" });
  });

  it("caps matches and flags the result as truncated", () => {
    const editor = new Editor({
      extensions: [...createRichTextPreset(), FindReplace.configure({ maxMatches: 5 })],
      content: docOf("a a a a a a a a"),
    });
    editors.push(editor);
    const s = find(editor, "a");
    expect(s.matches).toHaveLength(5);
    expect(s.truncated).toBe(true);
  });

  it("skips tracked-deleted text when replacing under Track Changes", () => {
    const editor = createEditor("one cat two cat", { tracking: true });
    editor.commands.setTextSelection(1);
    expect(count(editor, "cat")).toBe(2);
    editor.commands.setSearch({ replacement: "dog" });
    const remaining: number[] = [];
    for (let i = 0; i < 4; i++) {
      editor.commands.replaceCurrent();
      remaining.push(state(editor).matches.length);
    }
    expect(remaining).toEqual([1, 0, 0, 0]);
    expect(count(editor, "cat")).toBe(0);
    expect(text(editor)).toContain("cat");
    editor.commands.acceptAllChanges();
    expect(text(editor)).toBe("one dog two dog");

    // A match that runs across tracked-deleted text is not in the document.
    const cat = createEditor("cat", { tracking: true });
    deleteRange(cat, 1, 2);
    expect(text(cat)).toBe("cat");
    expect(count(cat, "cat")).toBe(0);
    expect(count(cat, "t")).toBe(1);

    // Without Track Changes, Replace steps through every match.
    const plain = createEditor("one cat two cat");
    plain.commands.setTextSelection(1);
    plain.commands.setSearch({ query: "cat", replacement: "dog", options: NO_OPTIONS });
    expect(plain.commands.replaceCurrent()).toBe(true);
    expect(plain.commands.replaceCurrent()).toBe(true);
    expect(state(plain).matches).toHaveLength(0);
    expect(plain.commands.replaceCurrent()).toBe(false);
    expect(text(plain)).toBe("one dog two dog");
  });

  it("reads the live text around tracked deletions", () => {
    const tracked = (value: string, edits: [number, number][]) => {
      const editor = createEditor(value, { tracking: true });
      for (const [a, b] of edits) deleteRange(editor, a, b);
      expect(text(editor)).toBe(value);
      return editor;
    };
    // Offsets are doc positions: the paragraph's text starts at 1.
    let editor = tracked("aaa", [[0, 1]]);
    expect(ranges(editor, "aa")).toEqual([[2, 4]]);
    expect(ranges(editor, "^a", { regex: true })).toEqual([[2, 3]]);
    expect(replaceAll(editor, "aa", "b")).toBe(1);

    // Whole words follow the live text: deleting the space joins "cat" and "fish"...
    editor = tracked("cat fish", [[3, 4]]);
    expect(count(editor, "fish", { wholeWord: true })).toBe(0);
    expect(count(editor, "catfish", { wholeWord: true })).toBe(0); // may not span a deletion
    expect(count(editor, "fish")).toBe(1);
    // ...and deleting the "X" leaves "fish" a word of its own.
    editor = tracked("cat Xfish", [[4, 5]]);
    expect(ranges(editor, "FISH", { wholeWord: true })).toEqual([[6, 10]]);
    expect(count(editor, "FISH", { wholeWord: true, matchCase: true })).toBe(0);

    // Find Next / Previous agree with Find.
    editor = tracked("aaa aaa", [[4, 5], [0, 1]]);
    editor.commands.setTextSelection(1);
    expect(count(editor, "aa")).toBe(2);
    editor.commands.findNext();
    expect(state(editor).currentIndex).toBe(0);
    expect(editor.state.selection).toMatchObject({ from: 2, to: 4 });
    editor.commands.findNext();
    expect(state(editor).currentIndex).toBe(1);
    editor.commands.findPrevious();
    expect(state(editor).currentIndex).toBe(0);
    editor.commands.findPrevious(); // wraps
    expect(state(editor).currentIndex).toBe(1);
  });

  it("tracks Replace All when Track Changes is on, as one undo step", () => {
    const original = "We walked towards the light, then towards home.";
    const editor = createEditor(original, { tracking: true });
    expect(replaceAll(editor, "towards", "toward", { matchCase: true })).toBe(2);
    expect(getTrackedChanges(editor).map((c) => `${c.type}:${c.text}`)).toEqual([
      "deletion:towards",
      "insertion:toward",
      "deletion:towards",
      "insertion:toward",
    ]);
    expect(getEditorText(editor)).toBe("We walked toward the light, then toward home.");
    // Replaced text is not found again.
    expect(count(editor, "towards", { matchCase: true })).toBe(0);
    editor.commands.undo();
    expect(text(editor)).toBe(original);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.redo();
    editor.commands.rejectAllChanges();
    expect(text(editor)).toBe(original);
  });

  it("splits paragraphs at a paragraph mark in the replacement", () => {
    for (const replacement of ["A^pB", "A\rB", "A\u2029B"]) {
      const editor = createEditor("cat cat");
      replaceAll(editor, "cat", replacement);
      expect(paragraphs(editor), JSON.stringify(replacement)).toEqual(["A", "B A", "B"]);
    }
    // A line feed (^l) stays a line break.
    const editor = createEditor("cat");
    replaceAll(editor, "cat", "A^lB");
    expect(paragraphs(editor)).toEqual(["AB"]);
    expect(editor.getHTML()).toBe("<p>A<br>B</p>");
  });

  it("keeps the found text's formatting and supports ^c", () => {
    const editor = createEditor();
    editor.commands.setContent("<p>a <strong>bold</strong> b</p>");
    replaceAll(editor, "bold", "[^c]");
    expect(editor.getHTML()).toBe("<p>a <strong>[CLIP]</strong> b</p>");
  });

  it("Replace All is one undo step", () => {
    const editor = createEditor("a a a\na");
    expect(replaceAll(editor, "a", "b")).toBe(4);
    expect(text(editor)).toBe("b b b\nb");
    editor.commands.undo();
    expect(text(editor)).toBe("a a a\na");
  });

  it("decorates matches and the current match, and updates them as the document changes", () => {
    const editor = createEditor("cat cat cat");
    editor.commands.setTextSelection(4);
    find(editor, "cat");
    const dom = editor.view.dom;
    expect(dom.querySelectorAll(".pixerate-find-match")).toHaveLength(3);
    expect(dom.querySelectorAll(".pixerate-find-match-current")).toHaveLength(1);
    expect(state(editor).currentIndex).toBe(1);
    editor.commands.insertContentAt(1, "cat ");
    expect(state(editor).matches).toHaveLength(4);
    // The current match follows its text.
    expect(state(editor).currentIndex).toBe(2);
    editor.commands.closeFindReplace();
    expect(dom.querySelectorAll(".pixerate-find-match")).toHaveLength(0);
    expect(state(editor).query).toBe("cat");
    editor.commands.clearSearch();
    expect(state(editor).query).toBe("");
  });

  it("opens with Mod+F / Mod+H, prefilling the selected text, and steps with F3", () => {
    const editor = createEditor("alpha beta alpha");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = editor.view;
    const press = (init: KeyboardEventInit) =>
      view.someProp("handleKeyDown", (f) => f(view, new window.KeyboardEvent("keydown", init))) ?? false;
    // `Mod` is Ctrl or Cmd depending on the platform the keymap detected.
    const key = (init: KeyboardEventInit) =>
      init.ctrlKey ? press(init) || press({ ...init, ctrlKey: false, metaKey: true }) : press(init);
    expect(key({ key: "f", ctrlKey: true })).toBe(true);
    expect(state(editor)).toMatchObject({ open: true, mode: "find", query: "alpha", focusRequest: 1 });
    expect(state(editor).matches).toHaveLength(2);
    key({ key: "h", ctrlKey: true });
    expect(state(editor)).toMatchObject({ open: true, mode: "replace", focusRequest: 2 });
    editor.commands.setTextSelection(1);
    key({ key: "F3" });
    expect(editor.state.selection).toMatchObject({ from: 1, to: 6 });
    key({ key: "F3" });
    expect(editor.state.selection).toMatchObject({ from: 12, to: 17 });
  });

  it("exposes a cached external store", () => {
    const editor = createEditor("x y x");
    const store = getFindReplaceStore(editor)!;
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.matches.length));
    const before = store.getSnapshot();
    editor.commands.setTextSelection(2);
    expect(store.getSnapshot()).toBe(before);
    find(editor, "x");
    expect(store.getSnapshot().matches).toHaveLength(2);
    expect(seen).toEqual([0, 2]);
    unsubscribe();
    expect(getFindReplaceStore(null)).toBeNull();
  });

  it("searchDocument works on a plain document", () => {
    const editor = createEditor("one\ntwo");
    const result = searchDocument(editor.state.doc, "e^pt", {}, { replacement: "[^&]" });
    expect(result.matches).toEqual([{ from: 3, to: 7, text: "e\rt", replacement: "[e\rt]" }]);
  });
});

describe("createFindReplaceCommands", () => {
  it("registers find and replace commands for the command registry", () => {
    const editor = createEditor("red green red");
    const registry = createCommandRegistry();
    registry.register(createFindReplaceCommands(editor));
    expect(registry.list().map((c) => c.id)).toEqual(
      expect.arrayContaining(["findReplace.open", "findReplace.next", "findReplace.replaceAll"]),
    );
    expect(registry.execute("findReplace.find", { query: "red", matchCase: true })).toMatchObject({
      ok: true,
      result: { count: 2 },
    });
    expect(registry.execute("findReplace.replaceAll", { query: "red", replacement: "blue" })).toMatchObject({
      ok: true,
      result: { replaced: 2 },
    });
    expect(text(editor)).toBe("blue green blue");
    expect(registry.execute("findReplace.find", { query: "[", wildcards: true })).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(registry.execute("findReplace.open")).toMatchObject({ ok: true });
    expect(state(editor).open).toBe(true);
  });
});
