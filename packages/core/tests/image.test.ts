import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  Markdown,
  Image,
  createRichTextPreset,
  createEditor,
  markdownToTipTapHtml,
  getEditorMarkdown,
  handleImageInsertion,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).FileReader = dom.window.FileReader;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

describe("Image extension and paste support in @pixerate/editor", () => {
  it("includes Image extension by default in createRichTextPreset", () => {
    const preset = createRichTextPreset();
    const hasImage = preset.some((ext: any) => ext.name === "image");
    expect(hasImage).toBe(true);
  });

  it("can disable Image extension when image: false", () => {
    const preset = createRichTextPreset({ image: false });
    const hasImage = preset.some((ext: any) => ext.name === "image");
    expect(hasImage).toBe(false);
  });

  it("parses and serializes markdown images correctly", () => {
    const md = "Here is a screenshot:\n\n![Dashboard](https://example.com/dash.png)";
    const editor = new Editor({
      extensions: createRichTextPreset({ markdown: true }),
      content: md,
    });

    const html = editor.getHTML();
    expect(html).toContain("<img");
    expect(html).toContain('src="https://example.com/dash.png"');
    expect(html).toContain('alt="Dashboard"');

    const serialized = getEditorMarkdown(editor);
    expect(serialized).toContain("![Dashboard](https://example.com/dash.png)");

    editor.destroy();
  });

  it("calls upload handler and updates image src when image is inserted", async () => {
    const uploadMock = vi.fn().mockResolvedValue("https://storage.googleapis.com/test-bucket/uploaded.png");

    const editor = new Editor({
      extensions: [
        ...createRichTextPreset({
          markdown: true,
          image: {
            upload: uploadMock,
          },
        }),
      ],
      content: "<p>Initial text</p>",
    });

    const fakeFile = new File(["fake image content"], "screenshot.png", { type: "image/png" });

    handleImageInsertion(editor.view, fakeFile, { upload: uploadMock });

    // Wait for the async upload promise to resolve
    await vi.waitFor(() => {
      expect(uploadMock).toHaveBeenCalledWith(fakeFile);
    });

    await vi.waitFor(() => {
      const html = editor.getHTML();
      expect(html).toContain('src="https://storage.googleapis.com/test-bucket/uploaded.png"');
      expect(html).toContain('alt="screenshot.png"');
    });

    const md = getEditorMarkdown(editor);
    expect(md).toContain("![screenshot.png](https://storage.googleapis.com/test-bucket/uploaded.png)");

    editor.destroy();
  });
});
