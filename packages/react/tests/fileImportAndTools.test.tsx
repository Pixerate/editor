// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { ToolRegistry, createRichTextToolProvider, type AgentToolProvider } from "@pixerate/editor/agent";
import { fileImportPluginKey, richClipboardPluginKey } from "@pixerate/editor";
import {
  useEditor,
  usePromptEditor,
  useFileImport,
  useAgentToolProvider,
  type UseFileImportResult,
} from "../src";
import { buildDocx, p as docxParagraph, r as docxRun } from "../../core/tests/helpers/zip-writer";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const textFile = (name: string, content: string) => new File([content], name);
const hasPlugin = (editor: Editor, key: any) =>
  editor.state.plugins.some((p) => (p as any).key === key.key);

describe("useEditor file import / rich clipboard options", () => {
  it("keeps existing behaviour by default and enables both features when opted in", async () => {
    const editors: Record<string, Editor | null> = {};
    function Harness({ name, ...props }: { name: string; fileImport?: boolean; richClipboard?: boolean }) {
      editors[name] = useEditor({ immediatelyRender: true, content: "<p>x</p>", ...props });
      return null;
    }
    await act(async () => {
      root.render(
        <>
          <Harness name="plain" />
          <Harness name="opted" fileImport richClipboard />
        </>,
      );
    });
    expect(hasPlugin(editors.plain!, fileImportPluginKey)).toBe(false);
    expect(hasPlugin(editors.plain!, richClipboardPluginKey)).toBe(false);
    expect(hasPlugin(editors.opted!, fileImportPluginKey)).toBe(true);
    expect(hasPlugin(editors.opted!, richClipboardPluginKey)).toBe(true);
  });

  it("usePromptEditor imports dropped files as plain text only when opted in", async () => {
    let editor: Editor | null = null;
    const onContentChange = vi.fn();
    function Harness({ fileImport }: { fileImport?: boolean }) {
      editor = usePromptEditor({ content: "", onContentChange, fileImport });
      return null;
    }
    await act(async () => root.render(<Harness />));
    expect(hasPlugin(editor!, fileImportPluginKey)).toBe(false);

    await act(async () => root.render(<Harness fileImport />));
    expect(hasPlugin(editor!, fileImportPluginKey)).toBe(true);
    const plugin = editor!.state.plugins.find((p) => (p as any).key === (fileImportPluginKey as any).key)!;
    const event = { dataTransfer: { files: [textFile("p.md", "# Title {var}")] }, clientX: 0, clientY: 0, preventDefault: vi.fn() };
    await act(async () => {
      expect((plugin.props.handleDrop as any).call(plugin, editor!.view, event, null, false)).toBe(true);
    });
    await vi.waitFor(() => expect(onContentChange).toHaveBeenLastCalledWith("# Title {var}"));
  });
});

describe("useFileImport", () => {
  it("imports files into the editor and exposes reactive state", async () => {
    let editor: Editor | null = null;
    let fileImport!: UseFileImportResult;
    function Harness() {
      editor = useEditor({ immediatelyRender: true, content: "<p></p>" });
      fileImport = useFileImport(editor);
      return <span data-testid="state">{fileImport.isImporting ? "busy" : fileImport.error ? "error" : "idle"}</span>;
    }
    await act(async () => root.render(<Harness />));
    expect(fileImport.accept).toContain(".md");
    expect(container.textContent).toBe("idle");

    await act(async () => {
      await fileImport.importFiles([textFile("a.md", "## Imported"), textFile("b.txt", "<tag>")]);
    });
    expect(editor!.getHTML()).toMatch(/<h2[^>]*>Imported<\/h2>/);
    expect(editor!.getHTML()).toContain("&lt;tag&gt;");
    expect(fileImport.lastOutcomes.map((o) => o.adapterId)).toEqual(["markdown", "text"]);

    await act(async () => {
      await fileImport.importFiles([textFile("x.pdf", "")]);
    });
    expect(container.textContent).toBe("error");
    expect(fileImport.error).toMatchObject({ code: "unsupported_type" });
  });

  it("imports .docx files through the default registry", async () => {
    let editor: Editor | null = null;
    let fileImport!: UseFileImportResult;
    function Harness() {
      editor = useEditor({ immediatelyRender: true, content: "<p></p>" });
      fileImport = useFileImport(editor);
      return null;
    }
    await act(async () => root.render(<Harness />));
    expect(fileImport.accept).toContain(".docx");
    const bytes = await buildDocx({
      body: docxParagraph(docxRun("Word title"), '<w:pStyle w:val="Heading1"/>') + docxParagraph(docxRun("italic", "<w:i/>")),
    });
    await act(async () => {
      await fileImport.importFiles([new File([bytes], "report.docx")]);
    });
    expect(fileImport.error).toBeNull();
    expect(fileImport.lastOutcomes.map((o) => o.adapterId)).toEqual(["docx"]);
    expect(editor!.getHTML()).toMatch(/<h1[^>]*>Word title<\/h1>/);
    expect(editor!.getHTML()).toContain("<em>italic</em>");
  });

  it("openFilePicker imports the chosen files", async () => {
    let editor: Editor | null = null;
    let fileImport!: UseFileImportResult;
    function Harness() {
      editor = useEditor({ immediatelyRender: true, content: "<p></p>" });
      fileImport = useFileImport(editor, { multiple: false });
      return null;
    }
    await act(async () => root.render(<Harness />));
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      expect(this.multiple).toBe(false);
      Object.defineProperty(this, "files", { value: [textFile("pick.txt", "picked")] });
      this.dispatchEvent(new Event("change"));
    });
    await act(async () => {
      await fileImport.openFilePicker();
    });
    expect(editor!.getText()).toBe("picked");
    click.mockRestore();
  });
});

describe("useAgentToolProvider", () => {
  it("registers on mount, re-registers on provider change and unregisters on unmount", async () => {
    const registry = new ToolRegistry();
    const make = (id: string, name: string): AgentToolProvider => ({
      id,
      tools: [{ name, inputSchema: { type: "object" }, handler: () => name }],
    });
    const a = make("a", "tool_a");
    const b = make("b", "tool_b");
    function Harness({ provider }: { provider: AgentToolProvider | null }) {
      useAgentToolProvider(registry, provider);
      return null;
    }
    await act(async () => root.render(<Harness provider={null} />));
    expect(registry.providerIds()).toEqual([]);

    await act(async () => root.render(<Harness provider={a} />));
    expect(registry.providerIds()).toEqual(["a"]);
    await act(async () => root.render(<Harness provider={a} />));
    expect(registry.providerIds()).toEqual(["a"]);

    await act(async () => root.render(<Harness provider={b} />));
    expect(registry.providerIds()).toEqual(["b"]);

    await act(async () => root.render(<></>));
    expect(registry.providerIds()).toEqual([]);
  });

  it("exposes a mounted editor's tools and announces removal on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const registry = new ToolRegistry();
      const changes: string[][] = [];
      registry.onListChanged((tools) => changes.push(tools.map((t) => t.name)));
      function DocEditor({ id }: { id: string }) {
        const editor = useEditor({ immediatelyRender: true, content: "<p>hello</p>" });
        const provider = useMemo(() => (editor ? createRichTextToolProvider(editor, { id }) : null), [editor, id]);
        useAgentToolProvider(registry, provider);
        return null;
      }
      await act(async () => root.render(<><DocEditor id="one" /><DocEditor id="two" /></>));
      vi.runAllTimers();
      expect(registry.listTools().tools.map((t) => t.name)).toContain("one__get_text");
      const result = await registry.callTool("two__get_text", {});
      expect((result.structuredContent as any).content).toBe("hello");

      await act(async () => root.render(<DocEditor id="one" />));
      vi.runAllTimers();
      expect(registry.listTools().tools.map((t) => t.name)).toEqual(["get_text", "insert_text", "replace_selection"]);
      expect(changes.at(-1)).toEqual(["get_text", "insert_text", "replace_selection"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
