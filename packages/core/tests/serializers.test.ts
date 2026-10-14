import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  escapeHtml,
  plainTextToTipTapHtml,
  htmlToPlainText,
  markdownToTipTapHtml,
  extractMentionsFromDoc,
  sanitizeHtml,
  sanitizeImportedHtml,
  plainTextToParagraphHtml,
  rtfToPlainText,
  PIXERATE_DOCUMENT_MIME,
  getSchemaSignature,
  serializeRichClipboardPayload,
  parseRichClipboardPayload,
  getClipboardData,
} from "../src/serializers";
import { createEditor, createRichTextPreset, richClipboardPluginKey } from "../src";

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

  it("handles malformed mention spans quickly", () => {
    // Growth with input size is checked in html-scan.test.ts; this is a smoke test.
    expect(htmlToPlainText("<span data-type='mention' ".repeat(20000))).toContain("<span");
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

describe("Serializers: markdown HTML sanitization", () => {
  it("strips event handlers and unsafe URLs from embedded HTML", () => {
    const html = markdownToTipTapHtml(
      'a <img src=x onerror=alert(1)> b <a href="javascript:alert(1)" onclick="x()">link</a>',
    );
    expect(html).toContain('<img src="x">');
    expect(html).toContain("<a>link</a>");
    expect(html).not.toMatch(/onerror|onclick|javascript:/i);
  });

  it("blocks obfuscated javascript: URLs", () => {
    const html = markdownToTipTapHtml(
      '<a href="java&#x09;script:alert(1)">x</a> <a href="&#106;avascript:alert(1)">y</a>',
    );
    expect(html).not.toMatch(/href/);
  });

  it("escapes disallowed tags such as script, style and iframe", () => {
    const html = markdownToTipTapHtml(
      "<script>alert(1)</script>\n\n<iframe src=\"https://evil\"></iframe> <style>*{}</style>",
    );
    expect(html).not.toMatch(/<script|<iframe|<style/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops style attributes but keeps data-* and class", () => {
    const html = markdownToTipTapHtml(
      '<span class="x" style="position:fixed" data-type="mention" data-id="u1" data-label="Ada">@Ada</span>',
    );
    expect(html).toContain(
      '<span class="x" data-type="mention" data-id="u1" data-label="Ada">@Ada</span>',
    );
  });

  it("keeps preprocessed mentions and file links intact", () => {
    const html = markdownToTipTapHtml(
      "Ping @ada about [`main.ts`](file:///src/main.ts)",
      { preprocessFileLinks: true, preprocessMentions: true, mentionables: [{ id: "u1", label: "ada" }] as any },
    );
    expect(html).toContain('data-type="mention"');
    expect(html).toContain('data-label="ada"');
    expect(html).toContain(
      '<a href="file:///src/main.ts" data-file-link="true" title="Click to copy file path"><code>main.ts</code></a>',
    );
  });

  it("escapes quotes and HTML in preprocessed file link hrefs and labels", () => {
    const html = markdownToTipTapHtml(
      '[x](file:///a"onmouseover="alert(1)) [<img src=x onerror=alert(1)>](file:///b)',
      { preprocessFileLinks: true },
    );
    // Injected text may only appear escaped inside attribute values / text.
    expect(html).not.toMatch(/\sonmouseover=|<img/);
    expect(html).toContain(">&lt;img src=x onerror=alert(1)&gt;</a>");
    expect(html).toContain('href="file:///a&quot;onmouseover=&quot;alert(1"');
  });

  it("only allows checkbox inputs (used by task lists)", () => {
    expect(markdownToTipTapHtml("- [x] done")).toContain('type="checkbox"');
    const html = markdownToTipTapHtml('<input type="text" value="x"> <input type=checkbox onclick="x()">');
    expect(html).toContain('&lt;input type=&quot;text&quot;');
    expect(html).toContain('<input type="checkbox">');
  });

  it("allows raw HTML through when allowUnsafeHtml is set", () => {
    const html = markdownToTipTapHtml('<span style="color:red">x</span>', {
      allowUnsafeHtml: true,
    });
    expect(html).toContain('<span style="color:red">x</span>');
  });
});

describe("Serializers: imported HTML, plain text and RTF", () => {
  it("sanitizeHtml escapes disallowed tags by default and strips them on request", () => {
    expect(sanitizeHtml("<section>a</section>")).toBe("&lt;section&gt;a&lt;/section&gt;");
    expect(sanitizeHtml("<section>a</section>", { disallowedTags: "strip" })).toBe("a");
    expect(sanitizeHtml('<p onclick="x()">a</p>', { disallowedTags: "strip" })).toBe("<p>a</p>");
  });

  it("sanitizeImportedHtml keeps the body and drops scripts, styles, comments and metadata", () => {
    const html = sanitizeImportedHtml(`<!DOCTYPE html>
<html><head><title>T</title><style>p { color: red }</style></head>
<body><!-- note --><h1>Title</h1><script>alert(1)</script>
<section><p class="x" style="color:red">Hello <b>world</b><o:p></o:p></p></section>
<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a></body></html>`);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain('<p class="x">Hello <b>world</b></p>');
    expect(html).toContain('<img src="x">');
    expect(html).toContain("<a>bad</a>");
    expect(html).not.toMatch(/script|style|alert|<title|note|<section|o:p/i);
  });

  it("sanitizeImportedHtml drops an unclosed script and returns an empty paragraph for empty input", () => {
    expect(sanitizeImportedHtml("<p>a</p><script>while(1){}")).toBe("<p>a</p>");
    expect(sanitizeImportedHtml("")).toBe("<p></p>");
    expect(sanitizeImportedHtml("<head><title>x</title></head>")).toBe("<p></p>");
  });

  it("plainTextToParagraphHtml always escapes, unlike plainTextToTipTapHtml", () => {
    const text = "<p><img src=x onerror=alert(1)></p>";
    expect(plainTextToTipTapHtml(text)).toBe(text);
    expect(plainTextToParagraphHtml(text)).toBe(
      "<p>&lt;p&gt;&lt;img src=x onerror=alert(1)&gt;&lt;/p&gt;</p>",
    );
    expect(plainTextToParagraphHtml("a\r\nb")).toBe("<p>a</p><p>b</p>");
  });

  it("rtfToPlainText extracts paragraphs, escapes and unicode, skipping metadata", () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}{\\colortbl;\\red255\\green0\\blue0;}" +
      "{\\info{\\title Secret}{\\author Someone}}{\\*\\generator Writer;}" +
      "\\pard\\f0\\fs24 Hello {\\b bold} world\\par\n" +
      "Braces \\{x\\} and \\\\ slash\\tab tab\\line next\\par\n" +
      "Caf\\'e9 \\u8364? price \\uc2\\u8212\\'97\\'97 dash \\ldblquote q\\rdblquote\\par\n" +
      "{\\pict\\pngblip 89504e47}\\emdash end}";
    expect(rtfToPlainText(rtf)).toBe(
      "Hello bold world\nBraces {x} and \\ slash\ttab\nnext\n" +
        "Café € price — dash “q”\n—end",
    );
  });

  it("rtfToPlainText returns non-RTF input unchanged", () => {
    expect(rtfToPlainText("just text")).toBe("just text");
    expect(rtfToPlainText("")).toBe("");
  });
});

describe("Serializers: rich-text clipboard MIME", () => {
  beforeAll(() => {
    const dom = new JSDOM();
    globalThis.document = dom.window.document as any;
    globalThis.window = dom.window as any;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  });

  const makeClipboard = (initial: Record<string, string> = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      store,
      getData: (type: string) => store.get(type) ?? "",
      setData: (type: string, value: string) => void store.set(type, value),
      clearData: () => store.clear(),
    };
  };
  const clipboardEvent = (clipboardData: unknown) =>
    ({ clipboardData, preventDefault: vi.fn() }) as any;

  const richEditor = (content: string, extra: any = {}) =>
    new Editor({
      extensions: createRichTextPreset({ richClipboard: true, ...extra }),
      content,
    });
  const plugin = (editor: Editor) =>
    editor.state.plugins.find((p) => (p as any).key === (richClipboardPluginKey as any).key)!;
  const foreignEditor = () =>
    new Editor({ extensions: createRichTextPreset({ headingLevels: [1], mention: true }) });

  it("signature is stable for equal schemas and differs for different ones", () => {
    const a = richEditor("<p>a</p>");
    const b = richEditor("<p>b</p>");
    const c = foreignEditor();
    expect(getSchemaSignature(a.schema)).toBe(getSchemaSignature(b.schema));
    expect(getSchemaSignature(a.schema)).not.toBe(getSchemaSignature(c.schema));
    expect(getSchemaSignature(a.schema)).toMatch(/^pm1-[0-9a-f]{8}$/);
    [a, b, c].forEach((e) => e.destroy());
  });

  it("round-trips a slice through the payload and rejects mismatches", () => {
    const editor = richEditor("<h2>Title</h2><ul><li><p><strong>bold</strong> item</p></li></ul>");
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    const payload = serializeRichClipboardPayload(slice, editor.schema);
    expect(JSON.parse(payload)).toMatchObject({ version: 1, schema: getSchemaSignature(editor.schema) });
    expect(parseRichClipboardPayload(payload, editor.schema)!.eq(slice)).toBe(true);

    const other = foreignEditor();
    expect(parseRichClipboardPayload(payload, other.schema)).toBeNull();
    expect(parseRichClipboardPayload("{not json", editor.schema)).toBeNull();
    expect(parseRichClipboardPayload(JSON.stringify({ version: 2 }), editor.schema)).toBeNull();
    expect(parseRichClipboardPayload("", editor.schema)).toBeNull();
    editor.destroy();
    other.destroy();
  });

  it("reads clipboard data from native and React synthetic events", () => {
    const data = makeClipboard();
    expect(getClipboardData({ clipboardData: data })).toBe(data);
    expect(getClipboardData({ nativeEvent: { clipboardData: data } })).toBe(data);
    expect(getClipboardData(null)).toBeNull();
  });

  it("copy writes HTML, text and the custom MIME; paste restores formatting losslessly", () => {
    const source = richEditor("<h2>Title</h2><p>Some <strong>bold</strong> text</p>");
    source.commands.selectAll();
    const data = makeClipboard();
    const copyEvent = clipboardEvent(data);
    expect((plugin(source).props.handleDOMEvents as any).copy(source.view, copyEvent)).toBe(true);
    expect(copyEvent.preventDefault).toHaveBeenCalled();
    expect(data.store.get("text/html")).toContain("<strong>bold</strong>");
    expect(data.store.get("text/plain")).toContain("Title");
    expect(data.store.has(PIXERATE_DOCUMENT_MIME)).toBe(true);

    const target = richEditor("<p></p>");
    // HTML that would paste differently proves the JSON payload wins.
    data.store.set("text/html", "<p>from html</p>");
    const p = plugin(target);
    expect((p.props.handlePaste as any).call(p, target.view, clipboardEvent(data), Slice.empty)).toBe(true);
    expect(target.getHTML()).toMatch(/<h2[^>]*>Title<\/h2><p>Some <strong>bold<\/strong> text<\/p>$/);
    expect(target.getHTML()).not.toContain("from html");
    source.destroy();
    target.destroy();
  });

  it("cut removes the selection after writing the clipboard", () => {
    const editor = richEditor("<p>keep cut</p>");
    editor.commands.setTextSelection({ from: 6, to: 9 });
    const data = makeClipboard();
    expect((plugin(editor).props.handleDOMEvents as any).cut(editor.view, clipboardEvent(data))).toBe(true);
    expect(editor.getText()).toBe("keep ");
    expect(data.store.get("text/plain")).toBe("cut");
    editor.destroy();
  });

  it("falls back to default handling for empty selections, foreign schemas and plain-text mode", () => {
    const editor = richEditor("<p>a</p>");
    const copy = (plugin(editor).props.handleDOMEvents as any).copy;
    expect(copy(editor.view, clipboardEvent(makeClipboard()))).toBe(false);
    editor.commands.selectAll();
    expect(copy(editor.view, clipboardEvent(null))).toBe(false);

    const paste = (ed: Editor, payload: string) => {
      const p = plugin(ed);
      return (p.props.handlePaste as any).call(
        p,
        ed.view,
        clipboardEvent(makeClipboard({ [PIXERATE_DOCUMENT_MIME]: payload })),
        Slice.empty,
      );
    };
    const other = foreignEditor();
    const foreign = serializeRichClipboardPayload(
      other.state.doc.slice(0, other.state.doc.content.size),
      other.schema,
    );
    expect(paste(editor, foreign)).toBe(false);

    // EditorController in plainTextMode keeps paste on the plain-text path.
    const controller = createEditor({
      plainTextMode: true,
      extensions: createRichTextPreset({ richClipboard: true }),
      content: "x",
    });
    const own = serializeRichClipboardPayload(
      editor.state.doc.slice(0, editor.state.doc.content.size),
      editor.schema,
    );
    expect(controller.editor.storage.richClipboard.plainTextMode).toBe(true);
    expect(paste(controller.editor, own)).toBe(false);
    expect(paste(editor, own)).toBe(true);
    controller.destroy();
    editor.destroy();
    other.destroy();
  });

  it("handles a real paste event dispatched on the editor DOM", () => {
    const source = richEditor("<p><em>hi</em></p>");
    const payload = serializeRichClipboardPayload(source.state.doc.slice(1, 3), source.schema);
    const target = richEditor("<p>x</p>");
    target.commands.setTextSelection(2);
    const event = new (window as any).Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: makeClipboard({ [PIXERATE_DOCUMENT_MIME]: payload, "text/plain": "hi" }),
    });
    target.view.dom.dispatchEvent(event);
    expect(target.getHTML()).toBe("<p>x<em>hi</em></p>");
    source.destroy();
    target.destroy();
  });
});
