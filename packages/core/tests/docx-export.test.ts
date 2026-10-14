// Round-trip and privacy cases re-expressed from wordcraft's crates/docx/tests/{roundtrip.rs,privacy.rs,fixtures.rs}
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  CommentStore,
  createDocxParts,
  createRichTextPreset,
  createStyleRegistry,
  docxToDocumentImport,
  escapeXmlAttr,
  escapeXmlText,
  exportDocx,
  getTrackedChanges,
  readZip,
  applyImportedReviewData,
  writeZip,
  DocxExportController,
  docxFileName,
  type DocxJSONNode,
} from "../src";
import { buildZip } from "./helpers/zip-writer";
import { measureGrowth } from "./helpers/growth";

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).ClipboardEvent = (dom.window as any).ClipboardEvent ?? class extends dom.window.Event {};
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
});

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const PNG_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;

const alice = { id: "alice-id", name: "Alice Arden" };
const bob = { id: "bob-id", name: "Bob Brook" };
const T1 = Date.UTC(2026, 2, 4, 5, 6, 7);
const T2 = Date.UTC(2026, 2, 5, 5, 6, 7);

function makeEditor(content: string | DocxJSONNode, store?: CommentStore) {
  return new Editor({
    extensions: createRichTextPreset({
      comments: store ? { store, author: alice } : false,
      trackChanges: { enabled: false, author: alice },
      paragraphStyles: true,
    } as any),
    content: content as any,
  });
}

async function parts(data: Uint8Array): Promise<Record<string, string>> {
  const zip = await readZip(data);
  const out: Record<string, string> = {};
  for (const entry of zip.entries) {
    if (!entry.name.startsWith("word/media/")) out[entry.name] = await zip.readText(entry);
  }
  return out;
}

const xml = (text: string) => {
  const doc = new dom.window.DOMParser().parseFromString(text, "application/xml");
  expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  return doc;
};

/** Exports, imports and loads the result into a fresh editor. */
async function roundTrip(editor: Editor, options: Parameters<typeof exportDocx>[1] = {}, store?: CommentStore) {
  const { data, report } = await exportDocx(editor, options);
  const imported = await docxToDocumentImport(data, { trackedChanges: "marks" });
  const next = makeEditor(imported.html, store);
  return { data, report, imported, next };
}

describe("XML and ZIP writing", () => {
  it("escapes text and attributes and strips characters XML cannot carry", () => {
    expect(escapeXmlText(`a<b>&c"d'`)).toBe(`a&lt;b&gt;&amp;c"d'`);
    expect(escapeXmlAttr(`"x"\t'y'\n<&>`)).toBe("&quot;x&quot;&#9;&apos;y&apos;&#10;&lt;&amp;&gt;");
    expect(escapeXmlText("a\u0000b\u0001c\u000bd￿e\ud800f😀")).toBe("abcdef😀");
  });

  it("writes stored and deflated archives that readZip reads back", async () => {
    const big = "repeat ".repeat(2000);
    for (const compression of ["auto", "store"] as const) {
      const data = await writeZip(
        [
          { name: "a.txt", data: "hello" },
          { name: "dir/ü.txt", data: big },
          { name: "empty", data: new Uint8Array(0) },
        ],
        { compression },
      );
      const zip = await readZip(data);
      expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "dir/ü.txt", "empty"]);
      expect(await zip.readText("dir/ü.txt")).toBe(big);
      expect(zip.get("dir/ü.txt")!.method).toBe(compression === "store" ? 0 : 8);
    }
  });

  it("rejects unsafe and duplicate entry names", async () => {
    await expect(writeZip([{ name: "../evil", data: "" }])).rejects.toThrow(/Unsafe/);
    await expect(writeZip([{ name: "/abs", data: "" }])).rejects.toThrow(/Unsafe/);
    await expect(writeZip([{ name: "a", data: "" }, { name: "a", data: "" }])).rejects.toThrow(/Duplicate/);
  });
});

describe("DOCX export: package", () => {
  it("writes a minimal valid package with every part registered", async () => {
    const { data } = await exportDocx({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] }, { title: "T & C", author: "Ann" });
    const p = await parts(data);
    expect(Object.keys(p).slice(0, 2)).toEqual(["[Content_Types].xml", "_rels/.rels"]);
    for (const name of Object.keys(p)) if (name.endsWith(".xml") || name.endsWith(".rels")) xml(p[name]);
    const types = p["[Content_Types].xml"];
    for (const part of ["/word/document.xml", "/word/styles.xml", "/word/settings.xml", "/docProps/core.xml", "/docProps/app.xml"]) {
      expect(types).toContain(`PartName="${part}"`);
    }
    expect(p["_rels/.rels"]).toContain('Target="word/document.xml"');
    expect(p["word/_rels/document.xml.rels"]).toContain('Target="styles.xml"');
    expect(p["docProps/core.xml"]).toContain("<dc:title>T &amp; C</dc:title>");
    expect(p["docProps/core.xml"]).toContain("<dc:creator>Ann</dc:creator>");
    expect(p["word/document.xml"]).toContain('<w:t xml:space="preserve">Hi</w:t>');
    expect((await docxToDocumentImport(data)).html).toBe("<p>Hi</p>");
  });

  it("escapes hostile text, attributes and URLs", async () => {
    const doc: DocxJSONNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `</w:t><w:r>"&'\u0007`, marks: [{ type: "link", attrs: { href: 'https://x.test/?a=1&b="2"' } }] },
            { type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          ],
        },
        { type: "image", attrs: { src: PNG_URL, alt: `"><script>` } },
      ],
    };
    const { data, report } = await exportDocx(doc);
    const p = await parts(data);
    xml(p["word/document.xml"]);
    expect(p["word/document.xml"]).toContain("&lt;/w:t&gt;&lt;w:r&gt;\"&amp;'");
    expect(p["word/_rels/document.xml.rels"]).toContain('Target="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(p["word/_rels/document.xml.rels"]).not.toContain("javascript");
    expect(report.dropped).toContainEqual(expect.objectContaining({ kind: "link", reason: "unsafe URL scheme" }));
    const { html } = await docxToDocumentImport(data);
    expect(html).toContain('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">');
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;"');
  });

  it("embeds data-URL images, skips remote ones unless linked, and reports the rest", async () => {
    const doc: DocxJSONNode = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: PNG_URL, alt: "dot", width: 2000 } },
        { type: "image", attrs: { src: "https://cdn.test/a.png" } },
        { type: "image", attrs: { src: "data:image/svg+xml;base64,PHN2Zy8+" } },
        { type: "widget", attrs: {} },
      ],
    };
    const skipped = await exportDocx(doc);
    const zip = await readZip(skipped.data);
    expect(zip.get("word/media/image1.png")).toBeTruthy();
    const p = await parts(skipped.data);
    expect(p["[Content_Types].xml"]).toContain('Extension="png"');
    // Wider than the text area: scaled to 6.5".
    expect(p["word/document.xml"]).toContain(`cx="${624 * 9525}"`);
    expect(skipped.report.written.images).toBe(1);
    expect(skipped.report.dropped.map((d) => [d.kind, d.reason])).toEqual([
      ["image", 'remote image skipped (use remoteImages: "link")'],
      ["image", "unsupported image type"],
      ["node", "unsupported node"],
    ]);
    const { html } = await docxToDocumentImport(skipped.data);
    expect(html).toContain(`<img src="${PNG_URL}" alt="dot">`);

    const linked = await parts((await exportDocx(doc, { remoteImages: "link" })).data);
    expect(linked["word/_rels/document.xml.rels"]).toContain('Target="https://cdn.test/a.png" TargetMode="External"');
    expect(linked["word/document.xml"]).toContain("r:link=");
  });

  it("writes tables with grid spans, vertical merges and header rows", async () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: ["H1", "H2", "H3"].map((t) => ({ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", attrs: { rowspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "tall" }] }] },
                { type: "tableCell", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
                { type: "tableCell", content: [{ type: "paragraph" }] },
              ],
            },
          ],
        },
      ],
    } as any);
    // The table nodes may not be in this schema yet: export the JSON directly.
    const json: DocxJSONNode = editor.getJSON().content?.some((n: any) => n.type === "table")
      ? (editor.getJSON() as DocxJSONNode)
      : {
          type: "doc",
          content: [
            {
              type: "table",
              content: [
                { type: "tableRow", content: ["H1", "H2", "H3"].map((t) => ({ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
                {
                  type: "tableRow",
                  content: [
                    { type: "tableCell", attrs: { rowspan: 2, colwidth: [100] }, content: [{ type: "paragraph", content: [{ type: "text", text: "tall" }] }] },
                    { type: "tableCell", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] },
                  ],
                },
                {
                  type: "tableRow",
                  content: [
                    { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
                    { type: "tableCell", content: [{ type: "paragraph" }] },
                  ],
                },
              ],
            },
          ],
        };
    editor.destroy();
    const { data, report } = await exportDocx(json);
    expect(report.written.tables).toBe(1);
    const document = (await parts(data))["word/document.xml"];
    expect(document).toContain("<w:tblHeader/>");
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain("<w:vMerge/>");
    expect((document.match(/<w:gridCol /g) ?? []).length).toBe(3);
    const { html } = await docxToDocumentImport(data);
    expect(html).toBe(
      "<table><tbody>" +
        "<tr><th><p>H1</p></th><th><p>H2</p></th><th><p>H3</p></th></tr>" +
        '<tr><td rowspan="2"><p>tall</p></td><td colspan="2"><p>wide</p></td></tr>' +
        "<tr><td><p>x</p></td><td><p></p></td></tr>" +
        "</tbody></table><p></p>",
    );
  });
});

describe("DOCX export: round trip", () => {
  const CONTENT =
    "<h1>Report</h1>" +
    '<p data-style="Subtitle">A subtitle</p>' +
    '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> x<sup>2</sup> H<sub>2</sub>O <a href="https://example.com/a">link</a></p>' +
    "<ul><li><p>One</p><ol><li><p>Nested</p></li></ol></li><li><p>Two</p></li></ul>" +
    '<ol start="3"><li><p>Three</p></li><li><p>Four</p></li></ol>' +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li><li data-type="taskItem" data-checked="false"><p>Todo</p></li></ul>' +
    "<blockquote><p>Quoted</p><p>Twice</p></blockquote>" +
    "<pre><code>line 1\n  line 2</code></pre>" +
    "<p>Line<br>break\tand tab</p>" +
    "<h3>End</h3>";

  it("keeps content, structure and paragraph styles", async () => {
    const editor = makeEditor(CONTENT);
    const { next, report } = await roundTrip(editor);
    expect(report.dropped).toEqual([]);
    expect(next.getJSON()).toEqual(editor.getJSON());
    editor.destroy();
    next.destroy();
  });

  it("writes mentions as plain text", async () => {
    const editor = makeEditor('<p>Hi <span data-type="mention" data-id="ann" data-label="Ann">@Ann</span>!</p>');
    const { imported } = await roundTrip(editor);
    expect(imported.html).toBe("<p>Hi @Ann!</p>");
    editor.destroy();
  });

  it("writes the style registry with basedOn, next and links, and imports it back", async () => {
    const registry = createStyleRegistry();
    registry.upsert({
      id: "Callout",
      name: "Callout",
      kind: "paragraph",
      basedOn: "Normal",
      next: "Normal",
      linked: "CalloutChar",
      quick: true,
      paragraph: { textAlign: "center", spaceBefore: "12pt", indentLeft: "0.5in" },
      character: { bold: true, color: "#336699", fontSize: "14pt" },
    });
    registry.upsert({ id: "CalloutChar", name: "Callout Char", kind: "character", linked: "Callout", character: { italic: true } });
    const editor = makeEditor('<p data-style="Callout">Look</p><p>after</p>');
    const { data, imported } = await roundTrip(editor, { styles: registry });
    const styles = (await parts(data))["word/styles.xml"];
    expect(styles).toMatch(/<w:style w:type="paragraph" w:customStyle="1" w:styleId="Callout"><w:name w:val="Callout"\/><w:basedOn w:val="Normal"\/><w:next w:val="Normal"\/><w:link w:val="CalloutChar"\/>/);
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>');
    expect(styles).toContain('<w:jc w:val="center"/>');
    expect(styles).toContain('<w:color w:val="336699"/>');
    expect(imported.html).toBe('<p data-style="Callout">Look</p><p>after</p>');
    const callout = imported.styles!.get("Callout")!;
    expect(callout).toMatchObject({
      name: "Callout",
      kind: "paragraph",
      basedOn: "Normal",
      next: "Normal",
      linked: "CalloutChar",
      quick: true,
      paragraph: { textAlign: "center", spaceBefore: "12pt", indentLeft: "36pt" },
      character: { bold: true, color: "#336699", fontSize: "14pt" },
    });
    expect(imported.styles!.get("Heading2")!.block).toEqual({ type: "heading", attrs: { level: 2 } });
    expect(imported.styles!.get("CalloutChar")).toMatchObject({ kind: "character", linked: "Callout" });
    editor.destroy();
  });

  it("keeps comments with replies and resolved state", async () => {
    const store = new CommentStore();
    const editor = makeEditor(
      '<p>Intro <span data-comment-id="t1">first range</span> and <span data-comment-id="t2">sec</span></p><p><span data-comment-id="t2">ond range</span> end</p>',
      store,
    );
    store.load({
      version: 1,
      threads: [
        { id: "t1", anchor: null, author: alice, createdAt: T1, body: "Check this.\nSecond line", replies: [{ id: "r1", author: bob, body: "Agreed.", createdAt: T2 }], resolved: false, orphaned: false },
        { id: "t2", anchor: null, author: bob, createdAt: T2, body: "Spans paragraphs", replies: [], resolved: true, orphaned: false },
        { id: "gone", anchor: null, author: bob, createdAt: T2, body: "Orphan", replies: [], resolved: false, orphaned: true },
      ],
    });
    const { data, report, imported } = await roundTrip(editor);
    expect(report.written).toMatchObject({ comments: 2, replies: 1 });
    expect(report.dropped).toEqual([{ kind: "comment", name: "gone", reason: "comment text is not in the document", count: 1 }]);
    const p = await parts(data);
    xml(p["word/comments.xml"]);
    expect(p["word/commentsExtended.xml"]).toMatch(/w15:paraIdParent=/);
    expect(p["word/people.xml"]).toContain('w15:author="Alice Arden"><w15:presenceInfo w15:providerId="None" w15:userId="alice-id"/>');

    const threads = imported.comments!.threads;
    expect(threads.map((t) => ({ body: t.body, author: t.author, createdAt: t.createdAt, resolved: t.resolved, replies: t.replies.map((r) => [r.author, r.body, r.createdAt]) }))).toEqual([
      { body: "Check this.\nSecond line", author: alice, createdAt: T1, resolved: false, replies: [[bob, "Agreed.", T2]] },
      { body: "Spans paragraphs", author: bob, createdAt: T2, resolved: true, replies: [] },
    ]);
    const [t1, t2] = threads.map((t) => t.id);
    expect(imported.html).toBe(
      `<p>Intro <span data-comment-id="${t1}">first range</span> and <span data-comment-id="${t2}">sec</span></p>` +
        `<p><span data-comment-id="${t2}">ond range</span> end</p>`,
    );
    editor.destroy();
  });

  it("keeps tracked insertions, deletions, moves, formatting and block changes", async () => {
    const editor = makeEditor(
      `<h2 data-block-change='${JSON.stringify({ changeId: "b1", authorId: "bob-id", authorName: "Bob Brook", authorColor: null, createdAt: T2, previous: { type: "paragraph", attrs: {}, wrappers: [] } })}'>Promoted</h2>` +
        `<p>Keep <ins data-change-type="insertion" data-change-id="i1" data-author-id="alice-id" data-author-name="Alice Arden" data-created-at="${T1}">added <strong>bold</strong></ins>` +
        `<del data-change-type="deletion" data-change-id="d1" data-author-id="bob-id" data-author-name="Bob Brook" data-created-at="${T2}">removed</del> ` +
        `<del data-change-type="deletion" data-change-id="m1" data-move-id="m1" data-author-id="alice-id" data-author-name="Alice Arden" data-created-at="${T1}">Moved words here.</del></p>` +
        `<p><span data-change-type="format" data-change-id="f1" data-author-id="bob-id" data-author-name="Bob Brook" data-created-at="${T2}" data-format-before="[]" data-format-after='[{"type":"bold"}]'><strong>now bold</strong></span> ` +
        `<ins data-change-type="insertion" data-change-id="m2" data-move-id="m1" data-author-id="alice-id" data-author-name="Alice Arden" data-created-at="${T1}">Moved words here.</ins></p>`,
    );
    const summary = (ed: Editor) =>
      getTrackedChanges(ed).map((c) => ({
        type: c.type,
        author: c.author.name,
        id: c.author.id,
        at: c.createdAt,
        text: c.text,
        ...(c.format ? { format: c.format } : {}),
        ...(c.block ? { previous: c.block.previous.type } : {}),
      }));
    const { data, next, report } = await roundTrip(editor);
    expect(report.written.trackedChanges).toBeGreaterThanOrEqual(5);
    const document = (await parts(data))["word/document.xml"];
    expect(document).toContain("<w:moveFromRangeStart");
    expect(document).toContain('w:name="m1"');
    expect(document).toContain("<w:moveTo ");
    expect(document).toContain("<w:rPrChange ");
    expect(document).toContain("<w:pPrChange ");
    expect(document).toContain("<w:delText xml:space=\"preserve\">removed</w:delText>");
    expect(summary(next)).toEqual(summary(editor));
    const moves = getTrackedChanges(next).filter((c) => c.type === "move");
    expect(moves).toHaveLength(1);
    expect(moves[0].move).toMatchObject({ fromText: "Moved words here.", toText: "Moved words here." });
    editor.destroy();
    next.destroy();
  });

  it("strips authors with privacy: strip-authors", async () => {
    const store = new CommentStore();
    const editor = makeEditor(
      `<p><span data-comment-id="t1">Clause one.</span> <ins data-change-type="insertion" data-change-id="i1" data-author-id="alice-id" data-author-name="Alice Arden" data-created-at="${T1}">Added</ins><del data-change-type="deletion" data-change-id="d1" data-author-id="bob-id" data-author-name="Bob Brook" data-created-at="${T2}">Removed</del></p>`,
      store,
    );
    store.load([{ id: "t1", anchor: null, author: alice, createdAt: T1, body: "Check this.", replies: [{ id: "r", author: bob, body: "Agreed.", createdAt: T2 }], resolved: false, orphaned: false }]);
    const { data } = await exportDocx(editor, { privacy: "strip-authors", author: alice, title: "Draft terms" });
    const p = await parts(data);
    const all = Object.values(p).join("\n");
    for (const name of ["Alice", "Bob", "alice-id", "bob-id", '"AA"', '"BB"']) expect(all).not.toContain(name);
    expect(p["word/people.xml"]).toBeUndefined();
    expect(p["word/comments.xml"].match(/w:author="Author"/g)).toHaveLength(2);
    expect(p["word/comments.xml"].match(/w:initials="A"/g)).toHaveLength(2);
    expect(p["word/document.xml"].match(/w:author="Author"/g)).toHaveLength(2);
    expect(p["docProps/core.xml"]).not.toContain("dc:creator");
    expect(p["docProps/core.xml"]).toContain("Draft terms");
    expect(p["word/settings.xml"]).toContain("<w:removePersonalInformation/>");
    // Dates are kept (only names are personal information here).
    expect(all).toContain("2026-03-04T05:06:07Z");
    const imported = await docxToDocumentImport(data, { trackedChanges: "marks" });
    expect(imported.comments!.threads[0].author).toEqual({ id: "Author", name: "Author" });

    const kept = Object.values(await parts((await exportDocx(editor, { author: alice })).data)).join("\n");
    expect(kept).toContain('w:author="Alice Arden"');
    expect(kept).toContain('w:initials="AA"');
    expect(kept).toContain("<dc:creator>Alice Arden</dc:creator>");
    editor.destroy();
  });
});

describe("DOCX import: review data from Word", () => {
  const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
  const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

  /** wordcraft's privacy fixture: two commenters (one replying, resolved), a tracked insertion and deletion. */
  async function fixture(body: string, extra: Record<string, string> = {}) {
    const comments = `<w:comments ${W_NS}><w:comment w:id="1" w:author="Quill Ramsey" w:initials="QR" w:date="2026-03-01T10:00:00Z"><w:p w14:paraId="0000AA01"><w:r><w:t>Check this.</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="Ona Vettel" w:initials="OV" w:date="2026-03-02T10:00:00Z"><w:p w14:paraId="0000AA02"><w:r><w:t>Agreed.</w:t></w:r></w:p></w:comment></w:comments>`;
    const extended = `<w15:commentsEx ${W_NS}><w15:commentEx w15:paraId="0000AA01" w15:done="1"/><w15:commentEx w15:paraId="0000AA02" w15:paraIdParent="0000AA01" w15:done="1"/></w15:commentsEx>`;
    return buildZip([
      { name: "_rels/.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: "word/document.xml", data: `<w:document ${W_NS}><w:body>${body}</w:body></w:document>` },
      {
        name: "word/_rels/document.xml.rels",
        data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}comments" Target="comments.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>`,
      },
      { name: "word/comments.xml", data: comments },
      { name: "word/commentsExtended.xml", data: extended },
      ...Object.entries(extra).map(([name, data]) => ({ name, data })),
    ]);
  }

  const BODY =
    `<w:p><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:r><w:t>Clause one.</w:t></w:r><w:commentRangeEnd w:id="1"/><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="1"/></w:r></w:p>` +
    `<w:p><w:ins w:id="10" w:author="Quill Ramsey" w:date="2026-03-04T05:06:07Z"><w:r><w:t>Added</w:t></w:r></w:ins><w:ins w:id="12" w:author="Quill Ramsey" w:date="2026-03-04T05:06:07Z"><w:r><w:rPr><w:b/></w:rPr><w:t> more</w:t></w:r></w:ins><w:del w:id="11" w:author="Ona Vettel" w:date="2026-03-05T05:06:07Z"><w:r><w:delText>Removed</w:delText></w:r></w:del></w:p>`;

  it("imports threads with replies and resolved state, and comment ranges", async () => {
    const result = await docxToDocumentImport(await fixture(BODY));
    expect(result.comments!.threads).toHaveLength(1);
    const [thread] = result.comments!.threads;
    expect(thread).toMatchObject({
      author: { id: "Quill Ramsey", name: "Quill Ramsey" },
      body: "Check this.",
      resolved: true,
      createdAt: Date.parse("2026-03-01T10:00:00Z"),
      replies: [{ author: { id: "Ona Vettel", name: "Ona Vettel" }, body: "Agreed." }],
    });
    // Accepted by default: the existing behaviour for tracked changes is unchanged.
    expect(result.html).toBe(`<p><span data-comment-id="${thread.id}">Clause one.</span></p><p>Added<strong> more</strong></p>`);
    expect((await docxToDocumentImport(await fixture(BODY), { comments: false })).html).toBe("<p>Clause one.</p><p>Added<strong> more</strong></p>");
  });

  it("imports tracked changes as marks, merging adjacent runs of one change", async () => {
    const { html } = await docxToDocumentImport(await fixture(BODY), { trackedChanges: "marks", comments: false });
    const editor = makeEditor(html);
    const changes = getTrackedChanges(editor).map((c) => [c.type, c.author.name, c.text, c.createdAt]);
    expect(changes).toEqual([
      ["insertion", "Quill Ramsey", "Added more", Date.parse("2026-03-04T05:06:07Z")],
      ["deletion", "Ona Vettel", "Removed", Date.parse("2026-03-05T05:06:07Z")],
    ]);
    editor.destroy();
  });

  it("links moves through their range names and reads author ids from people.xml", async () => {
    const body =
      `<w:p><w:moveFromRangeStart w:id="1" w:name="move1" w:author="Quill Ramsey"/><w:moveFrom w:id="2" w:author="Quill Ramsey"><w:r><w:t>Travelling words.</w:t></w:r></w:moveFrom><w:moveFromRangeEnd w:id="1"/></w:p>` +
      `<w:p><w:r><w:t>Anchor </w:t></w:r><w:moveToRangeStart w:id="3" w:name="move1" w:author="Quill Ramsey"/><w:moveTo w:id="4" w:author="Quill Ramsey"><w:r><w:t>Travelling words.</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="3"/></w:p>`;
    const bytes = await buildZip([
      { name: "_rels/.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: "word/document.xml", data: `<w:document ${W_NS}><w:body>${body}</w:body></w:document>` },
      { name: "word/_rels/document.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/></Relationships>` },
      { name: "word/people.xml", data: `<w15:people ${W_NS}><w15:person w15:author="Quill Ramsey"><w15:presenceInfo w15:providerId="None" w15:userId="quill"/></w15:person></w15:people>` },
    ]);
    const { html } = await docxToDocumentImport(bytes, { trackedChanges: "marks" });
    const editor = makeEditor(html);
    const [move] = getTrackedChanges(editor);
    expect(move).toMatchObject({ type: "move", author: { id: "quill", name: "Quill Ramsey" } });
    expect(move.move).toMatchObject({ fromText: "Travelling words.", toText: "Travelling words." });
    // Accepted: only the destination; original: only the source.
    expect((await docxToDocumentImport(bytes)).html).toBe("<p></p><p>Anchor Travelling words.</p>");
    expect((await docxToDocumentImport(bytes, { trackedChanges: "original" })).html).toBe("<p>Travelling words.</p><p>Anchor </p>");
    editor.destroy();
  });

  it("does not expand entities or follow external DTDs in comment parts", async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x "${"y".repeat(10)}"><!ENTITY big "&x;&x;&x;&x;&x;&x;&x;&x;&x;&x;">]><w:comments ${W_NS}><w:comment w:id="1" w:author="A"><w:p><w:r><w:t>&big;</w:t></w:r></w:p></w:comment></w:comments>`;
    const bytes = await buildZip([
      { name: "_rels/.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: "word/document.xml", data: `<w:document ${W_NS}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>` },
      { name: "word/_rels/document.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}comments" Target="comments.xml"/></Relationships>` },
      { name: "word/comments.xml", data: evil },
    ]);
    // Either the parser refuses the DTD (invalid_file) or the body stays bounded.
    const result = await docxToDocumentImport(bytes).catch((error) => error);
    if (result instanceof Error) expect((result as any).code).toBe("invalid_file");
    else expect((result.comments?.threads[0]?.body ?? "").length).toBeLessThanOrEqual(100);
  });
});

describe("DOCX export: controller", () => {
  it("tracks state, reports and downloads", async () => {
    const editor = makeEditor("<p>Doc</p>");
    const clicks: string[] = [];
    const origCreate = URL.createObjectURL;
    (URL as any).createObjectURL = () => "blob:test";
    (URL as any).revokeObjectURL = () => {};
    const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    const states: boolean[] = [];
    const controller = new DocxExportController(() => editor, { title: "My: report?" });
    controller.subscribe((s) => states.push(s.isExporting));
    const report = await controller.download();
    expect(report?.written.paragraphs).toBe(1);
    expect(clicks).toEqual(["My report.docx"]);
    expect(states[0]).toBe(true);
    expect(states[states.length - 1]).toBe(false);
    expect(controller.getState().lastReport).toBe(report);
    expect(docxFileName("")).toBe("document.docx");
    expect(await new DocxExportController(() => null).download()).toBeNull();
    dom.window.HTMLAnchorElement.prototype.click = anchorClick;
    (URL as any).createObjectURL = origCreate;
    editor.destroy();
  });

  it("loads imported comments and styles into the editor", async () => {
    const store = new CommentStore();
    const source = makeEditor('<p data-style="Note"><span data-comment-id="t1">hello</span></p>', store);
    store.load([{ id: "t1", anchor: null, author: alice, createdAt: T1, body: "Hi", replies: [], resolved: true, orphaned: false }]);
    const registry = createStyleRegistry();
    registry.upsert({ id: "Note", name: "Note", kind: "paragraph", basedOn: "Normal" });
    const { data } = await exportDocx(source, { styles: registry });
    const imported = await docxToDocumentImport(data);
    const targetStore = new CommentStore();
    const target = makeEditor("<p></p>", targetStore);
    target.commands.setContent(imported.html);
    expect(applyImportedReviewData(target, imported)).toEqual({ comments: 1, styles: 3 }); // Note, CommentReference, CommentText
    expect(applyImportedReviewData(target, imported)).toEqual({ comments: 0, styles: 0 });
    expect(targetStore.toJSON().threads).toMatchObject([{ body: "Hi", resolved: true }]);
    expect((target.storage as any).paragraphStyles.registry.get("Note")).toMatchObject({ basedOn: "Normal" });
    source.destroy();
    target.destroy();
  });

  it("grows linearly with paragraphs, comments and tracked changes", () => {
    const doc = (n: number): [DocxJSONNode, any[]] => {
      const content: DocxJSONNode[] = [];
      const threads: any[] = [];
      for (let i = 0; i < n; i++) {
        content.push({
          type: "paragraph",
          content: [
            { type: "text", text: `para ${i} <&> `, marks: [{ type: "comment", attrs: { commentId: `t${i}` } }] },
            { type: "text", text: "added", marks: [{ type: "insertion", attrs: { changeId: `c${i}`, authorName: "A", createdAt: T1 } }] },
          ],
        });
        threads.push({ id: `t${i}`, anchor: null, author: alice, createdAt: T1, body: "b", replies: [], resolved: false, orphaned: false });
      }
      return [{ type: "doc", content }, threads];
    };
    const [small, smallThreads] = doc(250);
    const [large, largeThreads] = doc(1000);
    const ratio = measureGrowth(
      () => createDocxParts(small, { comments: smallThreads }),
      () => createDocxParts(large, { comments: largeThreads }),
      { limit: 8 },
    );
    expect(ratio).toBeLessThan(8);
  });

  it("builds parts synchronously", () => {
    const { parts: list } = createDocxParts({ type: "doc", content: [] });
    expect(list.map((p) => p.name)).toContain("word/document.xml");
  });
});

describe("DOCX export: rich-text tables", () => {
  it("round-trips a preset table with a header row and spans through Word", async () => {
    const editor = makeEditor(
      "<table><tbody>" +
        "<tr><th><p>Item</p></th><th><p>Q1</p></th><th><p>Q2</p></th></tr>" +
        '<tr><td rowspan="2"><p>North</p></td><td colspan="2"><p>Both quarters</p></td></tr>' +
        "<tr><td><p>10</p></td><td><p>20</p></td></tr>" +
        "</tbody></table><p>After</p>",
    );
    const table = editor.getJSON().content?.[0];
    expect(table?.type).toBe("table");
    const { next, report } = await roundTrip(editor);
    expect(report.dropped).toEqual([]);
    const strip = (node: any): any =>
      node && typeof node === "object"
        ? Array.isArray(node)
          ? node.map(strip)
          : Object.fromEntries(Object.entries(node).filter(([k]) => k !== "colwidth").map(([k, v]) => [k, strip(v)]))
        : node;
    expect(strip(next.getJSON())).toEqual(strip(editor.getJSON()));
    editor.destroy();
    next.destroy();
  });
});
