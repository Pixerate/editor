import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import {
  escapeHtml,
  plainTextToTipTapHtml,
  htmlToPlainText,
  markdownToTipTapHtml,
  extractMentionsFromDoc,
} from "../src/serializers";
import { createEditor, createRichTextPreset } from "../src";

describe("Serializers: Plain Text & TipTap HTML", () => {
  it("escapes special HTML characters", () => {
    expect(escapeHtml(`<b>"test" & 'it'</b>`)).toBe(
      "&lt;b&gt;&quot;test&quot; &amp; &#039;it&#039;&lt;/b&gt;",
    );
  });

  it("converts plain text with newlines to TipTap paragraphs", () => {
    const text = "First line\nSecond line\n\nThird line";
    const html = plainTextToTipTapHtml(text);
    expect(html).toBe(
      "<p>First line</p><p>Second line</p><p></p><p>Third line</p>",
    );
  });

  it("leaves existing paragraph HTML untouched", () => {
    const existingHtml = "<p>Already HTML</p>";
    expect(plainTextToTipTapHtml(existingHtml)).toBe(existingHtml);
  });

  it("converts HTML paragraphs back to plain text with newlines", () => {
    const html = "<p>Line 1</p><p>Line 2</p>";
    const text = htmlToPlainText(html);
    expect(text).toBe("Line 1\nLine 2");
  });

  it("converts markdown file://, vscode://, and cursor:// links into anchor tags", () => {
    const markdown = "Check [TaskCard.svelte](file:///path/to/TaskCard.svelte) or [vscode](vscode://file/path) or [cursor](cursor://file/path)";
    const html = markdownToTipTapHtml(markdown);
    expect(html).toContain('<a href="file:///path/to/TaskCard.svelte">TaskCard.svelte</a>');
    expect(html).toContain('<a href="vscode://file/path">vscode</a>');
    expect(html).toContain('<a href="cursor://file/path">cursor</a>');
  });
});

describe("Serializers: plain text input is never parsed as HTML", () => {
  it("escapes plain text that merely contains a <p> tag", () => {
    expect(plainTextToTipTapHtml("I wrote <p> literally & more")).toBe(
      "<p>I wrote &lt;p&gt; literally &amp; more</p>",
    );
  });

  it("still passes through content that is paragraph HTML", () => {
    expect(plainTextToTipTapHtml("  <p>a</p><p>b</p>\n")).toBe(
      "  <p>a</p><p>b</p>\n",
    );
  });
});

const sharedHtmlCases: Array<[string, string, string]> = [
  ["paragraphs with an empty line", "<p>a</p><p></p><p>b</p>", "a\n\nb"],
  [
    "TipTap list items wrapped in paragraphs",
    "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    "one\ntwo",
  ],
  [
    "code blocks",
    "<p>intro</p><pre><code>x = 1</code></pre><p>end</p>",
    "intro\nx = 1\nend",
  ],
  ["escaped entities without double-decoding", "<p>&amp;lt;b&amp;gt; &amp; &lt;i&gt;</p>", "&lt;b&gt; & <i>"],
  ["leading empty paragraphs", "<p></p><p>a</p>", "\na"],
  [
    "mention spans as @label",
    '<p>hi <span data-type="mention" data-id="u1" data-label="Ada">@Ada</span>!</p>',
    "hi @Ada!",
  ],
  ["line breaks", "<p>a<br>b</p>", "a\nb"],
];

describe("Serializers: htmlToPlainText (Node fallback, no DOM)", () => {
  for (const [name, html, expected] of sharedHtmlCases) {
    it(`handles ${name}`, () => {
      expect(htmlToPlainText(html)).toBe(expected);
    });
  }

  it("handles malformed mention spans in linear time", () => {
    const malformed = "<span data-type='mention' ".repeat(2000);
    const start = performance.now();
    htmlToPlainText(malformed);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("Serializers: DOM-backed parsing", () => {
  let dom: JSDOM;

  beforeAll(() => {
    dom = new JSDOM();
    globalThis.document = dom.window.document as any;
    globalThis.window = dom.window as any;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  });

  for (const [name, html, expected] of sharedHtmlCases) {
    it(`htmlToPlainText handles ${name}`, () => {
      expect(htmlToPlainText(html)).toBe(expected);
    });
  }

  it("ignores formatting whitespace between blocks", () => {
    expect(htmlToPlainText("<p>a</p>\n  <p>b</p>\n")).toBe("a\nb");
  });

  it("parses HTML inertly without attaching it to the live document", () => {
    const html = '<p>x</p><img src="x" onerror="window.__pwned = true">';
    expect(htmlToPlainText(html)).toBe("x");
    expect(document.querySelector("img")).toBeNull();
    expect(extractMentionsFromDoc(
      '<span data-type="mention" data-id="u1" data-label="Ada">@Ada</span>' + html,
    )).toEqual([
      expect.objectContaining({ id: "u1", label: "Ada" }),
    ]);
  });

  it("EditorController.getPlainText does not repeat list items or drop code blocks", () => {
    const controller = createEditor({
      extensions: createRichTextPreset(),
      content: "<ul><li><p>one</p></li><li><p>two</p></li></ul><pre><code>code()</code></pre>",
    });
    expect(controller.getPlainText()).toBe("one\ntwo\ncode()");
    controller.destroy();
  });

  it("EditorController inserts text literally instead of parsing HTML", () => {
    const controller = createEditor({
      extensions: createRichTextPreset(),
      plainTextMode: true,
      content: "start",
    });
    controller.editor.commands.setTextSelection(controller.editor.state.doc.content.size - 1);
    controller.insertText(" a <b>bold</b> and <tag>");
    expect(controller.getPlainText()).toBe("start a <b>bold</b> and <tag>");

    controller.setPlainText("I wrote <p> literally & more");
    expect(controller.getPlainText()).toBe("I wrote <p> literally & more");

    controller.replaceRange(1, 8, "<i>x</i>");
    expect(controller.getPlainText()).toBe("<i>x</i> <p> literally & more");

    controller.insertTextAt(1, "line1\nline2 ");
    expect(controller.getPlainText()).toBe("line1\nline2 <i>x</i> <p> literally & more");

    controller.replaceRange(1, 6, "");
    expect(controller.getPlainText()).toBe("\nline2 <i>x</i> <p> literally & more");
    controller.destroy();
  });
});
