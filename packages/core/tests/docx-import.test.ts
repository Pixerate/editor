import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  createDocxImportAdapter,
  createImportAdapterRegistry,
  createRichTextPreset,
  defaultImportRegistry,
  docxToDocumentImport,
  fileImportPluginKey,
  getImportAccept,
  importFile,
  ImportError,
  type FileLike,
} from "../src";
import { buildDocx, buildZip, p, r } from "./helpers/zip-writer";

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const docx = async (parts: Parameters<typeof buildDocx>[0], options?: Parameters<typeof docxToDocumentImport>[1]) =>
  docxToDocumentImport(await buildDocx(parts), options);

const binaryFile = (name: string, bytes: Uint8Array, type = ""): FileLike => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer,
});

// 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const imageRun = (rId: string, alt: string) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="${alt}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const NUMBERING = `
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`;

const listPara = (text: string, numId: number, ilvl = 0) =>
  p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

describe("DOCX import: text structure", () => {
  it("maps paragraphs, headings by style id, style name and outline level", async () => {
    const { html, text } = await docx({
      styles: `
        <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
        <w:style w:type="paragraph" w:styleId="Berschrift2"><w:name w:val="heading 2"/></w:style>
        <w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My heading"/><w:basedOn w:val="Berschrift2"/></w:style>
        <w:style w:type="paragraph" w:styleId="Outline"><w:name w:val="Outline"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr></w:style>
        <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>`,
      body:
        p(r("Doc title"), '<w:pStyle w:val="Title"/>') +
        p(r("One"), '<w:pStyle w:val="Heading1"/>') +
        p(r("Two"), '<w:pStyle w:val="Berschrift2"/>') +
        p(r("Inherited"), '<w:pStyle w:val="MyHeading"/>') +
        p(r("Four"), '<w:pStyle w:val="Outline"/>') +
        p(r("Direct"), '<w:outlineLvl w:val="5"/>') +
        p(r("Body text")) +
        p(""),
    });
    expect(html).toBe(
      "<h1>Doc title</h1><h1>One</h1><h2>Two</h2><h2>Inherited</h2><h4>Four</h4><h6>Direct</h6><p>Body text</p><p></p>",
    );
    expect(text).toContain("Body text");
  });

  it("maps run formatting, merges adjacent runs and honours character styles", async () => {
    const { html } = await docx({
      styles: `<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`,
      body: p(
        r("Bold ", "<w:b/>") +
          r("still bold", "<w:b/>") +
          r(" plain ") +
          r("not bold", '<w:b w:val="0"/>') +
          r("it", "<w:i/>") +
          r("ul", '<w:u w:val="single"/>') +
          r("noul", '<w:u w:val="none"/>') +
          r("st", "<w:strike/>") +
          r("dst", "<w:dstrike/>") +
          r("sup", '<w:vertAlign w:val="superscript"/>') +
          r("sub", '<w:vertAlign w:val="subscript"/>') +
          r("styled", '<w:rStyle w:val="Strong"/>') +
          r("&lt;&amp;&gt;"),
      ),
    });
    expect(html).toBe(
      "<p><strong>Bold still bold</strong> plain not bold<em>it</em><u>ul</u>noul<s>stdst</s><sup>sup</sup><sub>sub</sub><strong>styled</strong>&lt;&amp;&gt;</p>",
    );
  });

  it("maps line breaks, tabs and non-breaking hyphens; ignores page breaks", async () => {
    const { html, text } = await docx({
      body: p(
        `<w:r><w:t>a</w:t><w:br/><w:t>b</w:t><w:tab/><w:t>c</w:t><w:br w:type="page"/><w:t>d</w:t><w:cr/><w:t>e</w:t><w:noBreakHyphen/><w:t>f</w:t></w:r>`,
      ),
    });
    expect(html).toBe("<p>a<br>b\tcd<br>e\u2011f</p>");
    expect(text).toContain("b\tc");
  });

  it("maps hyperlinks from relationships, anchors and HYPERLINK fields; drops unsafe URLs", async () => {
    const { html } = await docx({
      rels:
        '<Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>' +
        '<Relationship Id="rBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>',
      body:
        p(`<w:hyperlink r:id="rLink">${r("site", "<w:b/>")}</w:hyperlink>`) +
        p(`<w:hyperlink w:anchor="_Toc1">${r("jump")}</w:hyperlink>`) +
        p(`<w:hyperlink r:id="rBad">${r("evil")}</w:hyperlink>`) +
        p(
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example" </w:instrText></w:r>` +
            `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("field link")}<w:r><w:fldChar w:fldCharType="end"/></w:r>${r(" after")}`,
        ) +
        p(`<w:fldSimple w:instr=" HYPERLINK &quot;https://simple.example&quot; ">${r("simple")}</w:fldSimple>`) +
        p(
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("7")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
        ),
    });
    expect(html).toContain('<p><a href="https://example.com/a?b=1&amp;c=2"><strong>site</strong></a></p>');
    expect(html).toContain('<p><a href="#_Toc1">jump</a></p>');
    expect(html).toContain("<p><a>evil</a></p>");
    expect(html).not.toContain("javascript");
    expect(html).toContain('<p><a href="https://field.example">field link</a> after</p>');
    expect(html).toContain('<p><a href="https://simple.example">simple</a></p>');
    expect(html).toContain("<p>7</p>");
  });

  it("builds nested bulleted and numbered lists from numbering levels", async () => {
    const { html } = await docx({
      numbering: NUMBERING,
      body:
        p(r("Intro")) +
        listPara("Bullet A", 1) +
        listPara("Step 1", 1, 1) +
        listPara("Step 2", 1, 1) +
        listPara("Bullet B", 1) +
        p(r("Between")) +
        listPara("Third", 2) +
        listPara("Fourth", 2) +
        listPara("Unknown numbering", 99) +
        p(r("No list"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>'),
    });
    expect(html).toBe(
      "<p>Intro</p>" +
        "<ul><li><p>Bullet A</p><ol><li><p>Step 1</p></li><li><p>Step 2</p></li></ol></li><li><p>Bullet B</p></li></ul>" +
        "<p>Between</p>" +
        '<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>' +
        "<ul><li><p>Unknown numbering</p></li></ul>" +
        "<p>No list</p>",
    );
  });

  it("inherits list numbering from paragraph styles", async () => {
    const { html } = await docx({
      numbering: NUMBERING,
      styles: `<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>`,
      body: p(r("styled item"), '<w:pStyle w:val="ListNumber"/>'),
    });
    expect(html).toBe('<ol start="3"><li><p>styled item</p></li></ol>');
  });

  it("converts tables with header rows, gridSpan and vMerge", async () => {
    const tc = (content: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${content}</w:tc>`;
    const { html } = await docx({
      numbering: NUMBERING,
      body:
        listPara("before table", 1) +
        `<w:tbl><w:tblPr/><w:tblGrid/>` +
        `<w:tr><w:trPr><w:tblHeader/></w:trPr>${tc(p(r("H1")))}${tc(p(r("H2")))}${tc(p(r("H3")))}</w:tr>` +
        `<w:tr>${tc(p(r("tall")), '<w:vMerge w:val="restart"/>')}${tc(p(r("wide", "<w:b/>")), '<w:gridSpan w:val="2"/>')}</w:tr>` +
        `<w:tr>${tc(p(""), "<w:vMerge/>")}${tc(p(r("x")) + p(r("y")))}${tc("")}</w:tr>` +
        `</w:tbl>` +
        p(r("after")),
    });
    expect(html).toBe(
      "<ul><li><p>before table</p></li></ul>" +
        "<table><tbody>" +
        "<tr><th><p>H1</p></th><th><p>H2</p></th><th><p>H3</p></th></tr>" +
        '<tr><td rowspan="2"><p>tall</p></td><td colspan="2"><p><strong>wide</strong></p></td></tr>' +
        "<tr><td><p>x</p><p>y</p></td><td><p></p></td></tr>" +
        "</tbody></table>" +
        "<p>after</p>",
    );
  });

  it("imports tracked changes as accepted by default, or as the original", async () => {
    const body =
      p(
        r("Keep ") +
          `<w:ins w:id="1" w:author="A">${r("inserted ")}</w:ins>` +
          `<w:del w:id="2" w:author="A"><w:r><w:delText>deleted </w:delText></w:r></w:del>` +
          r("end"),
      ) + `<w:ins w:id="3"><w:p><w:r><w:t>ins para</w:t></w:r></w:p></w:ins>`;
    expect((await docx({ body })).html).toBe("<p>Keep inserted end</p><p>ins para</p>");
    expect((await docx({ body }, { trackedChanges: "original" })).html).toBe("<p>Keep deleted end</p>");
  });

  it("unwraps content controls and smart tags", async () => {
    const { html } = await docx({
      body:
        `<w:sdt><w:sdtPr/><w:sdtContent>${p(`<w:smartTag>${r("inside sdt")}</w:smartTag>`)}</w:sdtContent></w:sdt>` +
        p(`<w:sdt><w:sdtContent>${r("inline sdt")}</w:sdtContent></w:sdt>`),
    });
    expect(html).toBe("<p>inside sdt</p><p>inline sdt</p>");
  });

  it("appends footnotes in reference order and skips separators", async () => {
    const { html, text } = await docx({
      footnotes:
        `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
        `<w:footnote w:id="1">${p(`<w:r><w:footnoteRef/></w:r>${r(" First note")}`)}</w:footnote>` +
        `<w:footnote w:id="2">${p(r("Second note"))}</w:footnote>`,
      body: p(r("A") + `<w:r><w:footnoteReference w:id="2"/></w:r>` + r(" B") + `<w:r><w:footnoteReference w:id="1"/></w:r>`),
    });
    expect(html).toBe("<p>A<sup>1</sup> B<sup>2</sup></p><hr><ol><li><p>Second note</p></li><li><p> First note</p></li></ol>");
    expect(text).toContain("Second note");
  });

  it("follows the officeDocument relationship to a non-default main part", async () => {
    const { html } = await docx({ mainPath: "word/document2.xml", body: p(r("custom part")) });
    expect(html).toBe("<p>custom part</p>");
  });
});

describe("DOCX import: images", () => {
  const rels =
    '<Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
    '<Relationship Id="rEmf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.emf"/>' +
    '<Relationship Id="rExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/x.png" TargetMode="External"/>';
  const files = { "word/media/image1.png": PNG, "word/media/image2.emf": new Uint8Array([1, 2, 3]) };
  const body = p(r("Pic: ") + imageRun("rImg", "A &quot;dot&quot;")) + p(imageRun("rEmf", "vector") + imageRun("rExt", "linked"));

  it("embeds PNG/JPEG/GIF/WebP media as data URLs and skips other or linked images", async () => {
    const { html } = await docx({ rels, files, body });
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
    expect(html).toBe(`<p>Pic: <img src="${dataUrl}" alt="A &quot;dot&quot;"></p><p></p>`);
    expect(html).not.toContain("tracker.example");
  });

  it("honours images: false and maxImageSize", async () => {
    expect((await docx({ rels, files, body }, { images: false })).html).toBe("<p>Pic: </p><p></p>");
    expect((await docx({ rels, files, body }, { maxImageSize: 10 })).html).toBe("<p>Pic: </p><p></p>");
  });

  it("reads legacy VML images", async () => {
    const vml = `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:id="rImg" o:title="legacy" xmlns:o="urn:schemas-microsoft-com:office:office"/></v:shape></w:pict></w:r>`;
    const { html } = await docx({ rels, files, body: p(vml) });
    expect(html).toMatch(/^<p><img src="data:image\/png;base64,[^"]+" alt="legacy"><\/p>$/);
  });

  it("inserts images when the editor has the image extension and drops them otherwise", async () => {
    const result = await docx({ rels, files, body });
    const withImage = new Editor({ extensions: createRichTextPreset(), content: result.html });
    expect(withImage.getHTML()).toContain('src="data:image/png;base64,');
    withImage.destroy();
    const withoutImage = new Editor({ extensions: createRichTextPreset({ image: false }), content: result.html });
    expect(withoutImage.getHTML()).not.toContain("<img");
    expect(withoutImage.getText()).toContain("Pic:");
    withoutImage.destroy();
  });
});

describe("DOCX import: registry, errors and editor integration", () => {
  it("is registered in the default registry and accept list", async () => {
    expect(defaultImportRegistry.get("docx")).toBeDefined();
    expect(defaultImportRegistry.find({ fileName: "Report.DOCX" })?.id).toBe("docx");
    expect(
      defaultImportRegistry.find({
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })?.id,
    ).toBe("docx");
    expect(getImportAccept("document").split(",")).toEqual(
      expect.arrayContaining([".docx", ".docm", ".dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
    );
    const bytes = await buildDocx({ body: p(r("via registry"), '<w:pStyle w:val="Heading2"/>') });
    const outcome = await importFile<{ html: string; text: string }>(binaryFile("a.docx", bytes));
    expect(outcome.adapterId).toBe("docx");
    expect(outcome.result).toEqual({ html: "<h2>via registry</h2>", text: "via registry" });
  });

  it("rejects non-DOCX data with invalid_file ImportErrors", async () => {
    const registry = createImportAdapterRegistry();
    const notZip = registry.importFile(binaryFile("fake.docx", new TextEncoder().encode("hello")));
    await expect(notZip).rejects.toMatchObject({ name: "ImportError", code: "invalid_file", fileName: "fake.docx" });

    const zipWithoutDocument = await buildZip([{ name: "readme.txt", data: "x" }]);
    await expect(registry.importFile(binaryFile("b.docx", zipWithoutDocument))).rejects.toMatchObject({
      code: "invalid_file",
    });

    const badXml = await buildZip([{ name: "word/document.xml", data: "<w:document><unclosed>" }]);
    await expect(registry.importFile(binaryFile("c.docx", badXml))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("throws unsupported_environment without a DOMParser, and accepts an injected one", async () => {
    const bytes = await buildDocx({ body: p(r("injected")) });
    const original = (globalThis as any).DOMParser;
    const originalWindow = globalThis.window;
    (globalThis as any).DOMParser = undefined;
    (globalThis as any).window = undefined;
    try {
      const error = await docxToDocumentImport(bytes).catch((e) => e);
      expect(error).toBeInstanceOf(ImportError);
      expect(error.code).toBe("unsupported_environment");
      const adapter = createDocxImportAdapter({ DOMParser: dom.window.DOMParser as any });
      const registry = createImportAdapterRegistry({ builtIns: false });
      registry.register(adapter);
      const outcome = await registry.importFile<{ html: string }>(bytes, { fileName: "x.docx" });
      expect(outcome.result.html).toBe("<p>injected</p>");
    } finally {
      (globalThis as any).DOMParser = original;
      globalThis.window = originalWindow;
    }
  });

  it("dropping a .docx file onto an editor with FileImport inserts the converted content", async () => {
    const onImport = vi.fn();
    const editor = new Editor({
      extensions: createRichTextPreset({ fileImport: { onImport } }),
      content: "<p>start</p>",
    });
    const plugin = editor.state.plugins.find((pl) => (pl as any).key === (fileImportPluginKey as any).key)!;
    const bytes = await buildDocx({
      numbering: NUMBERING,
      body: p(r("Dropped heading"), '<w:pStyle w:val="Heading1"/>') + listPara("item", 1) + p(r("bold", "<w:b/>")),
    });
    const event = {
      dataTransfer: { files: [binaryFile("dropped.docx", bytes)] },
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
    } as any;
    const handled = (plugin.props.handleDrop as any).call(plugin, editor.view, event, Slice.empty, false);
    expect(handled).toBe(true);
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const html = editor.getHTML();
    expect(html).toMatch(/<h1[^>]*>Dropped heading<\/h1>/);
    expect(html).toMatch(/<ul[^>]*><li[^>]*><p[^>]*>item<\/p><\/li><\/ul>/);
    expect(html).toContain("<strong>bold</strong>");
    editor.destroy();
  });
});
