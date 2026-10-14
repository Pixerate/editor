// Style resolution cases re-expressed from wordcraft's crates/doc/src/styles.rs and
// crates/doc/src/resolve.rs tests (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { TextAlign } from "@tiptap/extension-text-align";
import {
  DEFAULT_STYLES,
  ParagraphStyles,
  TrackChanges,
  captureSelectionFormat,
  createParagraphStylesStore,
  createRichTextPreset,
  createStyleRegistry,
  getParagraphStyleAt,
  getStyleRegistry,
  getTrackedChanges,
  isValidStyleId,
  safeCSSValue,
  StyleRegistry,
} from "../src";
import { measureGrowth } from "./helpers/growth";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
});

describe("style registry", () => {
  it("has the built-in styles and a gallery in priority order", () => {
    const registry = createStyleRegistry();
    for (const id of ["Normal", "Title", "Subtitle", "Heading1", "Heading6", "Quote", "Code", "ListParagraph"]) {
      expect(registry.get(id)?.kind).toBe("paragraph");
    }
    expect(registry.find("heading 2")?.id).toBe("Heading2");
    const gallery = registry.gallery().map((s) => s.id);
    expect(gallery[0]).toBe("Normal");
    expect(gallery).toContain("Heading1");
    expect(gallery).not.toContain("Heading4");
    expect(registry.gallery("character").map((s) => s.id)).toEqual(["Emphasis", "Strong"]);
    expect(DEFAULT_STYLES.length).toBe(registry.list().length);
  });

  it("resolves defaults, then the basedOn chain, base first", () => {
    const registry = createStyleRegistry({
      defaults: { character: { fontFamily: "Inter", fontSize: "16px" }, paragraph: { lineHeight: "1.5" } },
    });
    registry.upsert({
      id: "Chapter",
      name: "Chapter",
      kind: "paragraph",
      basedOn: "Heading1",
      character: { color: "#c00" },
      paragraph: { textAlign: "center" },
    });
    const chapter = registry.resolve("Chapter");
    expect(chapter.character).toEqual({ fontFamily: "Inter", fontSize: "2em", bold: true, color: "#c00" });
    expect(chapter.paragraph).toMatchObject({ lineHeight: "1.5", textAlign: "center", spaceAfter: "0.25em" });
    // The block is inherited from Heading 1.
    expect(chapter.block).toEqual({ type: "heading", attrs: { level: 1 } });
    expect(registry.chain("Chapter").map((s) => s.id)).toEqual(["Normal", "Heading1", "Chapter"]);
    // Unknown styles resolve to the defaults in a paragraph.
    expect(registry.resolve("Nope")).toMatchObject({
      character: { fontFamily: "Inter", fontSize: "16px" },
      block: { type: "paragraph" },
    });
  });

  it("text resolution: paragraph style, then character style, then direct formatting", () => {
    const registry = createStyleRegistry({ defaults: { character: { fontSize: "12pt" } } });
    const text = registry.resolveText({ characterStyle: "Strong", direct: { italic: true } });
    expect(text).toEqual({ fontSize: "12pt", bold: true, italic: true });
    expect(registry.resolveText({ paragraphStyle: "Heading1", direct: { fontSize: "30px" } }).fontSize).toBe("30px");
    expect(registry.resolveText({ paragraphStyle: "NoSuchStyle" }).fontSize).toBe("12pt");
    // A linked character style takes its paragraph style's character formatting.
    expect(registry.resolveCharacterStyle("Heading1Char")).toEqual({ fontSize: "2em", bold: true });
    expect(registry.linkedCharacterStyle("Heading1")?.id).toBe("Heading1Char");
  });

  it("is cycle-safe", () => {
    const registry = createStyleRegistry();
    registry.update("Normal", { basedOn: "Heading1" });
    expect(registry.chain("Heading1").length).toBeLessThanOrEqual(2);
    registry.upsert({ id: "A", name: "A", kind: "paragraph", basedOn: "B", character: { color: "red" } });
    registry.upsert({ id: "B", name: "B", kind: "paragraph", basedOn: "A", character: { italic: true } });
    expect(registry.resolve("A").character).toMatchObject({ color: "red", italic: true });
    registry.upsert({ id: "Self", name: "Self", kind: "paragraph", basedOn: "Self" });
    expect(registry.chain("Self").map((s) => s.id)).toEqual(["Self"]);
    expect(() => registry.toCSS()).not.toThrow();
  });

  it("bounds long basedOn chains", () => {
    const registry = createStyleRegistry({ builtins: false });
    for (let i = 0; i < 100; i++) {
      registry.upsert({ id: `S${i}`, name: `S${i}`, kind: "paragraph", basedOn: i ? `S${i - 1}` : null });
    }
    expect(registry.chain("S99")).toHaveLength(32);
  });

  it("next style defaults to the style itself", () => {
    const registry = createStyleRegistry();
    expect(registry.nextStyleId("Heading2")).toBe("Normal");
    expect(registry.nextStyleId("Normal")).toBe("Normal");
    expect(registry.nextStyleId("ListParagraph")).toBe("ListParagraph");
    registry.upsert({ id: "Odd", name: "Odd", kind: "paragraph", next: "Missing" });
    expect(registry.nextStyleId("Odd")).toBe("Odd");
  });

  it("removes styles, rebasing dependants; built-ins cannot be removed", () => {
    const registry = createStyleRegistry();
    registry.upsert({ id: "Mid", name: "Mid", kind: "paragraph", basedOn: "Title" });
    registry.upsert({ id: "Leaf", name: "Leaf", kind: "paragraph", basedOn: "Mid", next: "Mid" });
    expect(registry.remove("Title")).toBeUndefined();
    expect(registry.remove("Mid")?.id).toBe("Mid");
    expect(registry.get("Leaf")).toMatchObject({ basedOn: "Title", next: null });
  });

  it("creates unique ids from names and validates ids", () => {
    const registry = createStyleRegistry();
    expect(registry.newId("My Style")).toBe("MyStyle");
    expect(registry.newId("Normal")).toBe("Normal1");
    expect(registry.newId("!!!")).toBe("Style");
    expect(registry.newId("1st place")).toBe("stplace");
    expect(isValidStyleId("Heading1")).toBe(true);
    expect(isValidStyleId('x"]{}')).toBe(false);
    expect(() => registry.upsert({ id: "bad id", name: "x", kind: "paragraph" })).toThrow(/Invalid style id/);
  });

  it("notifies subscribers with stable snapshots and round-trips through JSON", () => {
    const registry = createStyleRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    const before = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(before);
    registry.update("Title", { character: { color: "navy" } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot()).not.toBe(before);
    expect(registry.getSnapshot().version).toBe(before.version + 1);
    unsubscribe();

    const copy = createStyleRegistry(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(copy.resolve("Title")).toEqual(registry.resolve("Title"));
  });

  it("generates scoped CSS, including default-element selectors", () => {
    const registry = createStyleRegistry({ defaults: { character: { fontFamily: "Inter" } } });
    const css = registry.toCSS({ scope: ".doc" });
    expect(css).toContain(".doc { font-family: Inter; }");
    expect(css).toContain('.doc [data-style="Heading2"], .doc h2:not([data-style]) { margin-top: 1em; margin-bottom: 0.25em; font-size: 1.5em; font-weight: 700; }');
    expect(css).toContain('.doc [data-style="Title"] {');
    expect(css).toContain('.doc [data-char-style="Strong"] { font-weight: 700; }');
    expect(css).toContain('.doc [data-style="Code"], .doc pre:not([data-style])');
    // Normal sets nothing itself, so it has no rule.
    expect(css).not.toContain('[data-style="Normal"]');
  });

  it("drops unsafe CSS values", () => {
    expect(safeCSSValue("red; } body { display: none")).toBeUndefined();
    expect(safeCSSValue("url(https://evil.example/x.png)")).toBeUndefined();
    expect(safeCSSValue("</style><script>")).toBeUndefined();
    expect(safeCSSValue('"Fira Code", monospace')).toBe('"Fira Code", monospace');
    const registry = createStyleRegistry();
    registry.update("Title", { character: { color: "red; } * { color: blue" } });
    expect(registry.toCSS()).not.toContain("blue");
  });

  it("drops unsafe values in linear time", { timeout: 20000 }, () => {
    const small = "a".repeat(200_000) + "/";
    const large = "a".repeat(800_000) + "/";
    // Long values are rejected before the pattern runs: 4× the input is ~4× the
    // time (or less), never the ~16× of a quadratic scan.
    const ratio = measureGrowth(() => safeCSSValue(small), () => safeCSSValue(large), { limit: 10 });
    expect(ratio).toBeLessThan(10);
    expect(safeCSSValue("a".repeat(300))).toBeUndefined();
  });
});

function createEditor(content: string, options: { trackChanges?: boolean; registry?: StyleRegistry } = {}) {
  return new Editor({
    extensions: [
      ...createRichTextPreset({ headingLevels: [1, 2, 3, 4, 5, 6] }),
      ParagraphStyles.configure({ registry: options.registry ?? null }),
      ...(options.trackChanges
        ? [TrackChanges.configure({ enabled: true, author: { id: "a", name: "A" } })]
        : []),
    ],
    content,
  });
}

function select(editor: Editor, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
}

const styleAt = (editor: Editor, pos?: number) =>
  getParagraphStyleAt(editor.state, getStyleRegistry(editor)!, pos);

describe("ParagraphStyles extension", () => {
  it("maps headings and paragraphs to their default styles", () => {
    const editor = createEditor("<p>Body</p><h2>Head</h2><pre><code>x</code></pre>");
    expect(styleAt(editor, 1)).toBe("Normal");
    expect(styleAt(editor, 7)).toBe("Heading2");
    expect(styleAt(editor, editor.state.doc.content.size - 1)).toBe("Code");
    // Existing documents serialize unchanged.
    expect(editor.getHTML()).toBe('<p>Body</p><h2 class="font-bold tracking-tight">Head</h2><pre><code>x</code></pre>');
    editor.destroy();
  });

  it("applies heading styles as heading nodes without a styleId", () => {
    const editor = createEditor("<p>Hello</p>");
    expect(editor.commands.setParagraphStyle("Heading2")).toBe(true);
    expect(editor.getHTML()).toBe('<h2 class="font-bold tracking-tight">Hello</h2>');
    expect(styleAt(editor)).toBe("Heading2");
    editor.commands.clearParagraphStyle();
    expect(editor.getHTML()).toBe("<p>Hello</p>");
    editor.destroy();
  });

  it("applies paragraph styles with data-style and round-trips HTML", () => {
    const editor = createEditor("<p>Hello</p><p>World</p>");
    select(editor, 1, editor.state.doc.content.size - 1);
    editor.commands.setParagraphStyle("Title");
    const html = editor.getHTML();
    expect(html).toBe(
      '<p data-style="Title" class="pixerate-style-Title">Hello</p><p data-style="Title" class="pixerate-style-Title">World</p>',
    );
    const copy = createEditor(html);
    expect(copy.getHTML()).toBe(html);
    expect(styleAt(copy, 1)).toBe("Title");
    editor.destroy();
    copy.destroy();
  });

  it("ignores invalid data-style values when parsing", () => {
    const editor = createEditor('<p data-style="x&quot;]{}">Hi</p>');
    expect(editor.getHTML()).toBe("<p>Hi</p>");
    editor.destroy();
  });

  it("applies user styles based on headings and code", () => {
    const registry = createStyleRegistry();
    registry.upsert({ id: "Chapter", name: "Chapter", kind: "paragraph", basedOn: "Heading1" });
    const editor = createEditor("<p>One</p>", { registry });
    editor.commands.setParagraphStyle("Chapter");
    expect(editor.getHTML()).toBe('<h1 class="font-bold tracking-tight pixerate-style-Chapter" data-style="Chapter">One</h1>');
    editor.commands.setParagraphStyle("Code");
    expect(editor.getHTML()).toBe("<pre><code>One</code></pre>");
    editor.destroy();
  });

  it("rejects unknown, character and unavailable styles", () => {
    const editor = new Editor({
      extensions: [...createRichTextPreset({ headingLevels: [1, 2] }), ParagraphStyles],
      content: "<p>x</p>",
    });
    expect(editor.commands.setParagraphStyle("Nope")).toBe(false);
    expect(editor.commands.setParagraphStyle("Strong")).toBe(false);
    expect(editor.commands.setParagraphStyle("Heading5")).toBe(false);
    expect(editor.commands.setParagraphStyle("Heading2")).toBe(true);
    editor.destroy();
  });

  it("resets direct alignment so the style's alignment shows", () => {
    const registry = createStyleRegistry();
    registry.update("Title", { paragraph: { textAlign: "center" } });
    const editor = createEditor('<p style="text-align: right">x</p>', { registry });
    editor.commands.setParagraphStyle("Title");
    expect(editor.state.doc.firstChild!.attrs.textAlign).toBeNull();
    expect(editor.getHTML()).not.toContain("text-align");
    expect(registry.toCSS()).toContain("text-align: center");
    editor.destroy();
  });

  it("sets the style's alignment directly when TextAlign has a default alignment", () => {
    const registry = createStyleRegistry();
    registry.update("Title", { paragraph: { textAlign: "center" } });
    const editor = new Editor({
      extensions: [
        ...createRichTextPreset().filter((e: any) => e.name !== "textAlign"),
        TextAlign.configure({ types: ["heading", "paragraph"], defaultAlignment: "left" }),
        ParagraphStyles.configure({ registry }),
      ],
      content: "<p>x</p>",
    });
    editor.commands.setParagraphStyle("Title");
    expect(editor.state.doc.firstChild!.attrs.textAlign).toBe("center");
    editor.commands.clearParagraphStyle();
    expect(editor.state.doc.firstChild!.attrs.textAlign).toBe("left");
    editor.destroy();
  });

  it("applies the linked character style to a partial selection", () => {
    const editor = createEditor("<p>Hello world</p>");
    select(editor, 1, 6);
    editor.commands.setParagraphStyle("Heading1");
    expect(editor.getHTML()).toBe('<p><span data-char-style="Heading1Char">Hello</span> world</p>');
    editor.destroy();
  });

  it("sets and unsets character styles", () => {
    const editor = createEditor("<p>Hello world</p>");
    select(editor, 7, 12);
    expect(editor.commands.setCharacterStyle("Strong")).toBe(true);
    expect(editor.getHTML()).toBe('<p>Hello <span data-char-style="Strong">world</span></p>');
    expect(editor.commands.setCharacterStyle("Title")).toBe(false);
    editor.commands.unsetCharacterStyle();
    expect(editor.getHTML()).toBe("<p>Hello world</p>");
    editor.destroy();
  });

  it("applies the next style when Enter is pressed at the end of a paragraph", () => {
    const editor = createEditor("<p>Big title</p>");
    editor.commands.setParagraphStyle("Title");
    select(editor, editor.state.doc.firstChild!.nodeSize - 1);
    editor.commands.enter();
    expect(editor.getHTML()).toBe('<p data-style="Title" class="pixerate-style-Title">Big title</p><p></p>');
    expect(styleAt(editor)).toBe("Normal");
    editor.destroy();
  });

  it("keeps the style when a paragraph is split in the middle", () => {
    const editor = createEditor('<p data-style="Quote">To be or not</p>');
    select(editor, 6);
    editor.commands.enter();
    expect(editor.getHTML()).toBe(
      '<p data-style="Quote" class="pixerate-style-Quote">To be</p><p data-style="Quote" class="pixerate-style-Quote"> or not</p>',
    );
    editor.destroy();
  });

  it("keeps the style after Enter when the style's next is itself", () => {
    const editor = createEditor('<p data-style="ListParagraph">Item</p>');
    select(editor, 5);
    editor.commands.enter();
    expect(styleAt(editor)).toBe("ListParagraph");
    editor.destroy();
  });

  it("turns a custom heading style's next paragraph into its next style, and undoes with the split", () => {
    const registry = createStyleRegistry();
    registry.upsert({ id: "Chapter", name: "Chapter", kind: "paragraph", basedOn: "Heading1", next: "Subtitle" });
    const editor = createEditor('<h1 data-style="Chapter">One</h1>', { registry });
    select(editor, 4);
    editor.commands.enter();
    expect(styleAt(editor)).toBe("Subtitle");
    expect(editor.getHTML()).toContain('<p data-style="Subtitle" class="pixerate-style-Subtitle"></p>');
    editor.commands.undo();
    expect(editor.getHTML()).toBe('<h1 class="font-bold tracking-tight pixerate-style-Chapter" data-style="Chapter">One</h1>');
    editor.destroy();
  });

  it("updates a style to match the selection", () => {
    const editor = createEditor('<h2><strong><em>Head</em></strong></h2>');
    const registry = getStyleRegistry(editor)!;
    select(editor, 1, 5);
    expect(captureSelectionFormat(editor.state).character).toEqual({ bold: true, italic: true });
    expect(editor.commands.updateParagraphStyleFromSelection()).toBe(true);
    expect(registry.resolve("Heading2").character).toMatchObject({ bold: true, italic: true, fontSize: "1.5em" });
    editor.destroy();
  });

  it("creates a new style from the selection and applies it", () => {
    const editor = createEditor('<p style="text-align: center"><span style="color: #ff0000">Callout</span></p>');
    const registry = getStyleRegistry(editor)!;
    select(editor, 1, 8);
    expect(editor.commands.createParagraphStyleFromSelection("Callout box")).toBe(true);
    const style = registry.get("Calloutbox")!;
    expect(style).toMatchObject({ name: "Callout box", basedOn: "Normal", kind: "paragraph", quick: true });
    expect(style.character?.color).toBe("rgb(255, 0, 0)");
    expect(style.paragraph?.textAlign).toBe("center");
    expect(styleAt(editor)).toBe("Calloutbox");
    expect(editor.commands.createParagraphStyleFromSelection("  ")).toBe(false);
    expect(editor.commands.createParagraphStyleFromSelection("Again", { id: "Calloutbox" })).toBe(false);
    editor.destroy();
  });

  it("injects and updates the stylesheet while the editor exists", () => {
    const editor = createEditor("<p>x</p>");
    const element = document.head.querySelector("style[data-pixerate-paragraph-styles]")!;
    expect(element.textContent).toContain('[data-style="Title"]');
    getStyleRegistry(editor)!.update("Title", { character: { color: "rebeccapurple" } });
    expect(element.textContent).toContain("rebeccapurple");
    editor.destroy();
    expect(document.head.querySelector("style[data-pixerate-paragraph-styles]")).toBeNull();
  });

  it("is available through the rich-text preset", () => {
    const editor = new Editor({
      extensions: createRichTextPreset({ paragraphStyles: { injectCSS: false } }),
      content: '<p data-style="Subtitle">x</p>',
    });
    expect(getStyleRegistry(editor)?.get("Subtitle")).toBeTruthy();
    expect(styleAt(editor, 1)).toBe("Subtitle");
    editor.destroy();
  });

  it("records style changes as tracked block changes", () => {
    const editor = createEditor("<p>Hello</p>", { trackChanges: true });
    editor.commands.setParagraphStyle("Quote");
    const [change] = getTrackedChanges(editor);
    expect(change.type).toBe("block");
    expect(change.description).toBe("Changed style to Quote");
    editor.commands.rejectChange(change.id);
    expect(editor.getHTML()).toBe("<p>Hello</p>");
    editor.destroy();
  });

  it("exposes a store with the gallery and the current style", () => {
    const editor = createEditor("<p>Body</p><h1>Head</h1>");
    const store = createParagraphStylesStore(editor);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    expect(first.currentStyleId).toBe("Normal");
    expect(first.gallery.map((s) => s.id)).toContain("Title");
    expect(first.characterStyles.map((s) => s.id)).toEqual(["Emphasis", "Strong"]);
    select(editor, 7);
    expect(store.getSnapshot().currentStyleId).toBe("Heading1");
    expect(store.getSnapshot().gallery).toBe(first.gallery);
    const calls = listener.mock.calls.length;
    select(editor, 8);
    expect(listener.mock.calls.length).toBe(calls);
    getStyleRegistry(editor)!.upsert({ id: "New", name: "New", kind: "paragraph", quick: true });
    expect(store.getSnapshot().gallery.map((s) => s.id)).toContain("New");
    unsubscribe();
    store.destroy();
    editor.destroy();
  });
});
