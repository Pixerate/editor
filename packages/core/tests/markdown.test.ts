import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  Markdown,
  createRichTextPreset,
  createEditor,
  markdownToTipTapHtml,
  getEditorMarkdown,
  createMentionExtension,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

describe("Markdown Capabilities in @pixerate/editor", () => {
  describe("markdownToTipTapHtml serializer", () => {
    it("handles empty or falsy strings safely", () => {
      expect(markdownToTipTapHtml("")).toBe("<p></p>");
    });

    it("converts headings, bold, italic, and lists into HTML", () => {
      const md = "# Heading 1\n\n**bold** and *italic*\n\n- item 1\n- item 2";
      const html = markdownToTipTapHtml(md);
      expect(html).toContain("<h1>Heading 1</h1>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>item 1</li>");
    });

    it("converts task lists into HTML task checkboxes", () => {
      const md = "- [ ] Pending task\n- [x] Completed task";
      const html = markdownToTipTapHtml(md);
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('checked=""');
      expect(html).toContain("Pending task");
      expect(html).toContain("Completed task");
    });
  });

  describe("TipTap with createRichTextPreset({ markdown: true })", () => {
    it("parses markdown content into structured TipTap nodes", () => {
      const md = `# Project Plan

Here are the requirements:
- [ ] Task A
- [x] Task B

> Important quote

\`\`\`typescript
const answer = 42;
\`\`\`
`;
      const editor = new Editor({
        extensions: createRichTextPreset({ markdown: true }),
        content: md,
      });

      const html = editor.getHTML();
      expect(html).toContain("Project Plan");
      expect(html).toContain('data-type="taskList"');
      expect(html).toContain('data-type="taskItem"');
      expect(html).toContain("<blockquote>");
      expect(html).toContain("<pre><code");

      const exportedMd = getEditorMarkdown(editor);
      expect(exportedMd).toContain("# Project Plan");
      expect(exportedMd).toContain("- [ ] Task A");
      expect(exportedMd).toContain("- [x] Task B");
      expect(exportedMd).toContain("> Important quote");
      expect(exportedMd).toContain("const answer = 42;");

      editor.destroy();
    });

    it("preserves mentions across markdown roundtripping", () => {
      const mentionExt = createMentionExtension();
      const editor = new Editor({
        extensions: [...createRichTextPreset({ markdown: true }), mentionExt],
        content:
          'Hello <span data-type="mention" data-id="u1" data-label="supervisor">@supervisor</span>, please review.',
      });

      const md = getEditorMarkdown(editor);
      expect(md).toContain('data-type="mention"');
      expect(md).toContain('data-label="supervisor"');

      // Roundtrip back into a second editor
      const editor2 = new Editor({
        extensions: [...createRichTextPreset({ markdown: true }), mentionExt],
        content: md,
      });

      const docJson = editor2.getJSON();
      const hasMention = docJson.content?.some((node) =>
        node.content?.some(
          (child) =>
            child.type === "mention" && child.attrs?.label === "supervisor",
        ),
      );
      expect(hasMention).toBe(true);

      editor.destroy();
      editor2.destroy();
    });
  });

  describe("EditorController with markdownMode", () => {
    it("supports getMarkdown, setMarkdown, and onMarkdownChange", () => {
      let latestMarkdown = "";
      const controller = createEditor({
        markdownMode: true,
        extensions: createRichTextPreset({ markdown: true }),
        content: "# Initial Header\n\nSome text",
        onMarkdownChange: (md) => {
          latestMarkdown = md;
        },
      });

      expect(controller.getMarkdown()).toContain("# Initial Header");

      controller.setMarkdown("## Updated Header\n\n- [ ] New item");
      expect(controller.getMarkdown()).toContain("## Updated Header");
      expect(controller.getMarkdown()).toContain("- [ ] New item");

      controller.destroy();
    });
  });
});
