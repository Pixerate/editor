import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  ImportAdapterRegistry,
  ImportError,
  createImportAdapterRegistry,
  defaultImportRegistry,
  registerImportAdapter,
  findImportAdapter,
  importFile,
  getImportAccept,
  importFilesIntoEditor,
  insertImportedDocument,
  createRichTextPreset,
  createEditor,
  fileImportPluginKey,
  createFileImportController,
  pickImportFiles,
  type ImportAdapter,
  type DocumentImport,
  type FileLike,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const file = (name: string, content: string, type = ""): FileLike => ({
  name,
  type,
  size: content.length,
  text: async () => content,
});

const csvAdapter: ImportAdapter<{ rows: string[][] }> = {
  id: "csv-test",
  label: "CSV",
  mimeTypes: ["text/csv"],
  extensions: [".csv"],
  target: "spreadsheet",
  async import(_input, context) {
    const text = await context.readText();
    return { rows: text.split("\n").map((line) => line.split(",")) };
  },
};

describe("Import adapter registry: matching", () => {
  const registry = createImportAdapterRegistry();

  it("matches built-in adapters by extension, case-insensitively", () => {
    expect(registry.find({ fileName: "notes.md" })?.id).toBe("markdown");
    expect(registry.find({ fileName: "NOTES.MARKDOWN" })?.id).toBe("markdown");
    expect(registry.find({ fileName: "analysis.Rmd" })?.id).toBe("markdown");
    expect(registry.find({ fileName: "page.htm" })?.id).toBe("html");
    expect(registry.find({ fileName: "a.txt" })?.id).toBe("text");
    expect(registry.find({ fileName: "letter.rtf" })?.id).toBe("rtf");
    expect(registry.find({ fileName: "report.pdf" })).toBeUndefined();
  });

  it("prefers the longest extension (.md.txt beats .txt)", () => {
    expect(registry.find({ fileName: "readme.md.txt" })?.id).toBe("markdown");
    expect(registry.find({ fileName: "readme.txt" })?.id).toBe("text");
  });

  it("prefers extensions over MIME types, and falls back to MIME types", () => {
    // Browsers often report text/plain (or nothing) for markdown files.
    expect(registry.find({ fileName: "notes.md", mimeType: "text/plain" })?.id).toBe("markdown");
    expect(registry.find({ mimeType: "text/html; charset=utf-8" })?.id).toBe("html");
    expect(registry.find({ fileName: "noext", mimeType: "text/markdown" })?.id).toBe("markdown");
    expect(registry.find({ mimeType: "application/rtf" })?.id).toBe("rtf");
  });

  it("ranks exact MIME types above wildcards, then priority, then later registration", () => {
    const local = new ImportAdapterRegistry();
    const make = (id: string, extra: Partial<ImportAdapter> = {}): ImportAdapter => ({
      id,
      label: id,
      mimeTypes: [],
      extensions: [],
      target: "document",
      import: () => id,
      ...extra,
    });
    local.register(make("wild", { mimeTypes: ["text/*"] }));
    local.register(make("exact", { mimeTypes: ["text/x-foo"] }));
    expect(local.find({ mimeType: "text/x-foo" })?.id).toBe("exact");
    expect(local.find({ mimeType: "text/x-bar" })?.id).toBe("wild");

    local.register(make("first", { extensions: [".foo"] }));
    local.register(make("second", { extensions: ["foo"] }));
    expect(local.find({ fileName: "a.foo" })?.id).toBe("second");
    local.register(make("important", { extensions: [".foo"], priority: 10 }));
    local.register(make("late", { extensions: [".foo"] }));
    expect(local.find({ fileName: "a.foo" })?.id).toBe("important");
  });

  it("filters by target and builds accept strings", () => {
    const local = createImportAdapterRegistry();
    local.register(csvAdapter);
    expect(local.find({ fileName: "a.csv" })?.id).toBe("csv-test");
    expect(local.find({ fileName: "a.csv", target: "document" })).toBeUndefined();
    expect(local.find({ fileName: "a.md", target: "spreadsheet" })).toBeUndefined();
    expect(local.accept("spreadsheet")).toBe(".csv,text/csv");
    const documentAccept = local.accept("document").split(",");
    expect(documentAccept).toEqual(expect.arrayContaining([".md", ".md.txt", ".html", "text/html", ".txt", ".rtf"]));
    expect(documentAccept).not.toContain(".csv");
    expect(local.canImport({ name: "a.csv" })).toBe(true);
    expect(local.canImport({ name: "a.csv" }, "document")).toBe(false);
  });

  it("rejects duplicate ids unless replacing, and unregisters", () => {
    const local = createImportAdapterRegistry({ builtIns: false });
    expect(local.list()).toEqual([]);
    const unregister = local.register(csvAdapter);
    expect(() => local.register(csvAdapter)).toThrow(/already registered/);
    local.register({ ...csvAdapter, label: "CSV v2" }, { replace: true });
    expect(local.get("csv-test")?.label).toBe("CSV v2");
    expect(local.unregister("csv-test")).toBe(true);
    expect(local.unregister("csv-test")).toBe(false);
    unregister(); // no-op once removed
  });
});

describe("Import adapter registry: importing", () => {
  it("imports markdown with the sanitizing markdown pipeline", async () => {
    const outcome = await importFile<DocumentImport>(
      file("notes.md", "﻿# Title\n\n- **one**\n\n<img src=x onerror=alert(1)>"),
    );
    expect(outcome.adapterId).toBe("markdown");
    expect(outcome.target).toBe("document");
    expect(outcome.fileName).toBe("notes.md");
    expect(outcome.result.html).toContain("<h1>Title</h1>");
    expect(outcome.result.html).toContain("<strong>one</strong>");
    expect(outcome.result.html).not.toMatch(/onerror/);
    expect(outcome.result.text.startsWith("# Title")).toBe(true);
  });

  it("imports HTML, plain text and RTF", async () => {
    const html = await importFile<DocumentImport>(
      file("page.html", "<html><body><p onclick='x()'>Hi <script>bad()</script>there</p></body></html>", "text/html"),
    );
    expect(html.result.html).toBe("<p>Hi there</p>");
    expect(html.result.text).toBe("Hi there");

    const text = await importFile<DocumentImport>(file("a.txt", "<b>x</b>\r\nline 2"));
    expect(text.result).toEqual({ html: "<p>&lt;b&gt;x&lt;/b&gt;</p><p>line 2</p>", text: "<b>x</b>\nline 2" });

    const rtf = await importFile<DocumentImport>(file("a.rtf", "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Hello\\par World}"));
    expect(rtf.result.text).toBe("Hello\nWorld");
    expect(rtf.result.html).toBe("<p>Hello</p><p>World</p>");
  });

  it("accepts strings, ArrayBuffers and typed arrays with an explicit fileName or adapterId", async () => {
    const bytes = new TextEncoder().encode("﻿**b**");
    const fromBuffer = await importFile<DocumentImport>(bytes.buffer, { fileName: "x.md" });
    expect(fromBuffer.result.html).toContain("<strong>b</strong>");
    const fromView = await importFile<DocumentImport>(bytes, { mimeType: "text/markdown" });
    expect(fromView.adapterId).toBe("markdown");
    const fromString = await importFile<DocumentImport>("<i>x</i>", { adapterId: "html" });
    expect(fromString.result.html).toBe("<i>x</i>");
  });

  it("supports pluggable adapters for other targets (e.g. CSV → spreadsheet)", async () => {
    const unregister = registerImportAdapter(csvAdapter);
    try {
      expect(findImportAdapter({ fileName: "data.csv" })?.id).toBe("csv-test");
      expect(getImportAccept("spreadsheet")).toContain(".csv");
      const outcome = await importFile<{ rows: string[][] }>(file("data.csv", "a,b\n1,2"), { target: "spreadsheet" });
      expect(outcome.target).toBe("spreadsheet");
      expect(outcome.result.rows).toEqual([["a", "b"], ["1", "2"]]);
    } finally {
      unregister();
    }
    expect(findImportAdapter({ fileName: "data.csv" })).toBeUndefined();
  });

  it("rejects with structured ImportErrors", async () => {
    await expect(importFile(file("a.pdf", "%PDF"))).rejects.toMatchObject({
      name: "ImportError",
      code: "unsupported_type",
      fileName: "a.pdf",
    });
    await expect(importFile("x", { adapterId: "nope" })).rejects.toMatchObject({ code: "unknown_adapter" });

    const local = createImportAdapterRegistry({ builtIns: false });
    const cause = new Error("corrupt");
    local.register({ ...csvAdapter, import: () => { throw cause; } });
    const error = await local.importFile(file("a.csv", "")).catch((e) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error.code).toBe("adapter_failed");
    expect(error.cause).toBe(cause);
  });
});

describe("Import into the editor", () => {
  const makeEditor = (content = "<p>start end</p>", extra: any = {}) =>
    new Editor({ extensions: createRichTextPreset(extra), content });

  it("inserts imported HTML at a position and returns the end position", () => {
    const editor = makeEditor();
    const end = insertImportedDocument(editor, { html: "<h2>Head</h2>", text: "Head" }, { at: 7 });
    expect(editor.getHTML()).toMatch(/<p>start <\/p><h2[^>]*>Head<\/h2><p>end<\/p>/);
    expect(end).toBeGreaterThan(7);
    editor.destroy();
  });

  it("inserts text literally in plain-text mode", () => {
    const editor = makeEditor("<p></p>");
    insertImportedDocument(editor.view, { html: "<h2>x</h2>", text: "# x\n<b>y</b>" }, { asPlainText: true });
    expect(editor.getHTML()).toBe("<p># x</p><p>&lt;b&gt;y&lt;/b&gt;</p>");
    editor.destroy();

    // A drop position between blocks moves into the nearest textblock.
    const other = makeEditor("<p>tail</p>");
    insertImportedDocument(other, { html: "", text: "head " }, { at: 0, asPlainText: true });
    expect(other.getHTML()).toBe("<p>head tail</p>");
    other.destroy();
  });

  it("imports several files in order and reports unsupported ones", async () => {
    const editor = makeEditor("<p></p>");
    const onImport = vi.fn();
    const onError = vi.fn();
    const outcomes = await importFilesIntoEditor(
      editor,
      [file("a.md", "**A**"), file("b.pdf", "%PDF"), file("c.txt", "C")],
      { onImport, onError },
    );
    expect(outcomes.map((o) => o.adapterId)).toEqual(["markdown", "text"]);
    expect(onImport).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "unsupported_type" }), expect.objectContaining({ name: "b.pdf" }));
    const html = editor.getHTML();
    expect(html.indexOf("<strong>A</strong>")).toBeGreaterThan(-1);
    expect(html.indexOf("<strong>A</strong>")).toBeLessThan(html.indexOf("<p>C</p>"));
    editor.destroy();
  });

  it("FileImport is opt-in and handles drops of importable files only", async () => {
    expect(createRichTextPreset().some((ext: any) => ext.name === "fileImport")).toBe(false);

    const onImport = vi.fn();
    const editor = makeEditor("<p>x</p>", { fileImport: { onImport } });
    const plugin = editor.state.plugins.find((p) => (p as any).key === (fileImportPluginKey as any).key)!;
    const drop = (files: FileLike[], moved = false) => {
      const event = { dataTransfer: { files }, clientX: 0, clientY: 0, preventDefault: vi.fn() } as any;
      const handled = (plugin.props.handleDrop as any).call(plugin, editor.view, event, Slice.empty, moved);
      return { handled, event };
    };

    expect(drop([]).handled).toBe(false);
    expect(drop([file("a.png", "", "image/png")]).handled).toBe(false);
    expect(drop([file("a.md", "x"), file("b.png", "", "image/png")]).handled).toBe(false);
    expect(drop([file("a.md", "x")], true).handled).toBe(false);

    const { handled, event } = drop([file("dropped.md", "## Dropped")]);
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(editor.getHTML()).toMatch(/<h2[^>]*>Dropped<\/h2>/);
    editor.destroy();
  });

  it("FileImport inserts plain text when the EditorController is in plainTextMode", async () => {
    const onImport = vi.fn();
    const controller = createEditor({
      plainTextMode: true,
      extensions: createRichTextPreset({ fileImport: { onImport } }),
      content: "",
    });
    const plugin = controller.editor.state.plugins.find((p) => (p as any).key === (fileImportPluginKey as any).key)!;
    const event = { clipboardData: { files: [file("p.md", "# Not a heading")] }, preventDefault: vi.fn() } as any;
    expect((plugin.props.handlePaste as any).call(plugin, controller.editor.view, event, Slice.empty)).toBe(true);
    await vi.waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(controller.getPlainText()).toBe("# Not a heading");
    expect(controller.editor.getHTML()).not.toContain("<h1");
    controller.destroy();
  });

  it("FileImportController tracks importing state and errors", async () => {
    const editor = makeEditor("<p></p>");
    const controller = createFileImportController(() => editor);
    const states: boolean[] = [];
    const unsubscribe = controller.subscribe((s) => states.push(s.isImporting));
    expect(controller.accept).toContain(".md");

    const outcomes = await controller.importFiles([file("a.md", "*x*"), file("b.pdf", "")]);
    expect(outcomes).toHaveLength(1);
    expect(states).toEqual([true, false]);
    expect(controller.getState().error).toMatchObject({ code: "unsupported_type" });
    expect(controller.getState().lastOutcomes).toHaveLength(1);
    expect(editor.getHTML()).toContain("<em>x</em>");

    await controller.importFiles([file("c.txt", "ok")]);
    expect(controller.getState().error).toBeNull();
    expect(await createFileImportController(() => null).importFiles([file("c.txt", "x")])).toEqual([]);
    unsubscribe();
    editor.destroy();
  });

  it("pickImportFiles opens a hidden file input with the accept list", async () => {
    const clicks: HTMLInputElement[] = [];
    const click = vi
      .spyOn((window as any).HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        clicks.push(this);
      });
    const picked = pickImportFiles({ multiple: false });
    const input = clicks[0];
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(false);
    expect(input.accept).toContain(".md.txt");
    const chosen = new (window as any).File(["# hi"], "hi.md");
    Object.defineProperty(input, "files", { value: [chosen] });
    input.dispatchEvent(new (window as any).Event("change"));
    expect(await picked).toEqual([chosen]);
    expect(input.isConnected).toBe(false);
    click.mockRestore();
  });

  it("uses the default registry unless one is passed", () => {
    expect(defaultImportRegistry.get("markdown")).toBeDefined();
  });
});
