import { describe, it, expect, vi, beforeAll } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Editor } from "@tiptap/core";
import { ToolRegistry, createRichTextToolProvider, type AgentToolProvider } from "@pixerate/editor/agent";
import { createRichTextPreset, fileImportPluginKey, richClipboardPluginKey } from "@pixerate/editor";
import { EditableTextNodeEditor, createFileImport, useAgentToolProvider } from "../src";

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

    await fileImport.importFiles([textFile("a.docx", "")]);
    expect(fileImport.error).toMatchObject({ code: "unsupported_type" });

    current = undefined;
    expect(await fileImport.importFiles([textFile("a.txt", "x")])).toEqual([]);
    editor.destroy();
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
