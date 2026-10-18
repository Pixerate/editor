import { describe, it, expect, vi, beforeAll } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Editor } from "@tiptap/core";
import { ToolRegistry, createRichTextToolProvider, type AgentToolProvider } from "@pixerate/editor/agent";
import {
  createImportAdapterRegistry,
  createPdfImportAdapter,
  createRichTextPreset,
  fileImportPluginKey,
  richClipboardPluginKey,
} from "@pixerate/editor";
import { EditableTextNodeEditor, createFileImport, useAgentToolProvider } from "../src";
import { buildDocx, p as docxParagraph, r as docxRun } from "../../core/tests/helpers/zip-writer";
import { fakeStructuredPdfjs } from "../../core/tests/helpers/fake-pdfjs";

beforeAll(() => {
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

const textFile = (name: string, content: string) => new File([content], name);
const hasPlugin = (editor: Editor, key: any) =>
  editor.state.plugins.some((p) => (p as any).key === key.key);

function mountEditor(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(EditableTextNodeEditor, { target, props: { content: "<p>x</p>", ...props } });
  flushSync();
  const editor = (target.querySelector(".ProseMirror") as any)?.editor as Editor;
  return {
    editor,
    destroy: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe("EditableTextNodeEditor file import / rich clipboard props", () => {
  it("keeps existing behaviour by default and enables both features when opted in", () => {
    const plain = mountEditor({});
    expect(hasPlugin(plain.editor, fileImportPluginKey)).toBe(false);
    expect(hasPlugin(plain.editor, richClipboardPluginKey)).toBe(false);
    plain.destroy();

    const opted = mountEditor({ fileImport: true, richClipboard: true });
    expect(hasPlugin(opted.editor, fileImportPluginKey)).toBe(true);
    expect(hasPlugin(opted.editor, richClipboardPluginKey)).toBe(true);
    opted.destroy();
  });

  it("imports dropped markdown at the drop position", async () => {
    const onImport = vi.fn();
    const { editor, destroy } = mountEditor({ fileImport: { onImport } });
    const plugin = editor.state.plugins.find((p) => (p as any).key === (fileImportPluginKey as any).key)!;
    const event = { dataTransfer: { files: [textFile("a.md", "**bold**")] }, clientX: 0, clientY: 0, preventDefault: vi.fn() };
    expect((plugin.props.handleDrop as any).call(plugin, editor.view, event, null, false)).toBe(true);
    await vi.waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(editor.getHTML()).toContain("<strong>bold</strong>");
    destroy();
  });
});

describe("createFileImport", () => {
  it("imports files with reactive state", async () => {
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    let current: Editor | undefined = editor;
    const fileImport = createFileImport(() => current);
    expect(fileImport.accept).toContain(".rtf");
    expect(fileImport.isImporting).toBe(false);

    const pending = fileImport.importFiles([textFile("a.html", "<h3>Hi</h3><script>x()</script>")]);
    expect(fileImport.isImporting).toBe(true);
    await pending;
    expect(fileImport.isImporting).toBe(false);
    expect(editor.getHTML()).toMatch(/<h3[^>]*>Hi<\/h3>/);
    expect(editor.getHTML()).not.toContain("script");

    await fileImport.importFiles([textFile("a.pdf", "")]);
    expect(fileImport.error).toMatchObject({ code: "unsupported_type" });
    // DOCX is a built-in adapter now: an empty file is rejected as invalid, not unsupported.
    await fileImport.importFiles([textFile("a.docx", "")]);
    expect(fileImport.error).toMatchObject({ code: "invalid_file" });

    current = undefined;
    expect(await fileImport.importFiles([textFile("a.txt", "x")])).toEqual([]);
    editor.destroy();
  });
});

describe("PDF structure summary (Svelte)", () => {
  it("summarises detected structure and honours the structure toggle", async () => {
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(fakeStructuredPdfjs()));
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    const fileImport = createFileImport(() => editor, { registry });
    expect(fileImport.structureSummary).toBeNull();
    const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "doc.pdf", { type: "application/pdf" });
    await fileImport.importFiles([pdf()]);
    expect(fileImport.structureSummary).toMatchObject({ files: 1, mode: "structured", headings: 1, tables: 1, paragraphs: 1 });
    expect(editor.getHTML()).toMatch(/<h1[^>]*>Imported title<\/h1>/);

    fileImport.setOptions({ registry, adapterOptions: { pdf: { structure: false } } });
    await fileImport.importFiles([pdf()]);
    expect(fileImport.structureSummary).toMatchObject({ mode: "plain", headings: 0, tables: 0 });
    editor.destroy();
  });
});

describe("DOCX import (Svelte)", () => {
  it("createFileImport and dropped files use the built-in DOCX adapter", async () => {
    const bytes = await buildDocx({
      body: docxParagraph(docxRun("Svelte doc"), '<w:pStyle w:val="Heading2"/>') + docxParagraph(docxRun("struck", "<w:strike/>")),
    });
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    const fileImport = createFileImport(() => editor);
    expect(fileImport.accept).toContain(".docx");
    await fileImport.importFiles([new File([bytes], "a.docx")]);
    expect(fileImport.error).toBeNull();
    expect(editor.getHTML()).toMatch(/<h2[^>]*>Svelte doc<\/h2>/);
    expect(editor.getHTML()).toContain("<s>struck</s>");
    editor.destroy();

    const onImport = vi.fn();
    const mounted = mountEditor({ fileImport: { onImport } });
    const plugin = mounted.editor.state.plugins.find((p) => (p as any).key === (fileImportPluginKey as any).key)!;
    const event = { dataTransfer: { files: [new File([bytes], "drop.docx")] }, clientX: 0, clientY: 0, preventDefault: vi.fn() };
    expect((plugin.props.handleDrop as any).call(plugin, mounted.editor.view, event, null, false)).toBe(true);
    await vi.waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(mounted.editor.getHTML()).toMatch(/<h2[^>]*>Svelte doc<\/h2>/);
    mounted.destroy();
  });
});

describe("useAgentToolProvider (Svelte)", () => {
  const make = (id: string, name: string): AgentToolProvider => ({
    id,
    tools: [{ name, inputSchema: { type: "object" }, handler: () => name }],
  });

  it("registers while the effect is alive, follows getter changes and unregisters on cleanup", () => {
    const registry = new ToolRegistry();
    let provider = $state<AgentToolProvider | null>(null);
    const cleanup = $effect.root(() => {
      useAgentToolProvider(registry, () => provider);
    });
    flushSync();
    expect(registry.providerIds()).toEqual([]);

    provider = make("a", "tool_a");
    flushSync();
    expect(registry.providerIds()).toEqual(["a"]);

    provider = make("b", "tool_b");
    flushSync();
    expect(registry.providerIds()).toEqual(["b"]);

    cleanup();
    expect(registry.providerIds()).toEqual([]);
  });

  it("exposes a mounted editor's tools and removes them when it is destroyed", async () => {
    const registry = new ToolRegistry();
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p>hello</p>" });
    const cleanup = $effect.root(() => {
      useAgentToolProvider(registry, createRichTextToolProvider(editor, { id: "doc" }));
    });
    flushSync();
    const result = await registry.callTool("get_text", {});
    expect((result.structuredContent as any).content).toBe("hello");
    cleanup();
    expect(registry.listTools().tools).toEqual([]);
    editor.destroy();
  });
});

describe("agent caret in a mounted EditableTextNodeEditor", () => {
  it("draws the agent's caret where the rich-text tools write, as one undo step", async () => {
    const { editor, destroy } = mountEditor({ content: "<p>Hello brave world</p>" });
    const registry = new ToolRegistry();
    const cleanup = $effect.root(() => {
      useAgentToolProvider(
        registry,
        createRichTextToolProvider(editor, { id: "doc", presence: { name: "Claude", typing: { charsPerSecond: Infinity } } })
      );
    });
    flushSync();
    const result = await registry.callTool("replace_range", { from: 7, to: 12, text: "bold" });
    expect(result.structuredContent).toMatchObject({ range: { from: 7, to: 11 } });
    const caret = editor.view.dom.querySelector(".pe-agent-caret");
    expect(caret?.querySelector(".pe-agent-caret-label")?.textContent).toBe("Claude");
    expect(editor.view.dom.querySelector(".pe-agent-changed")?.textContent).toBe("bold");
    editor.commands.undo();
    expect(editor.getText()).toBe("Hello brave world");
    cleanup();
    destroy();
  });
});
