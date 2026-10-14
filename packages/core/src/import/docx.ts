import { sanitizeImportedHtml } from "../serializers/html";
import { escapeHtml, htmlToPlainText } from "../serializers/plain-text";
import type { DocumentImport, DocumentImportAdapter } from "./adapters";
import { ImportError } from "./registry";
import { readZip, type ZipArchive, type ZipReadOptions } from "./zip";

/**
 * Dependency-free DOCX (Office Open XML WordprocessingML) import.
 *
 * Reads the main document part (located through `_rels/.rels`), its
 * relationships, `styles.xml`, `numbering.xml`, `footnotes.xml` and
 * `endnotes.xml` with the platform `DOMParser`, and maps them to TipTap HTML:
 * paragraphs, headings (`Heading1`–`Heading6` / `Title` styles and outline
 * levels), bold / italic / underline / strike / super- and subscript,
 * hyperlinks (relationships, anchors and `HYPERLINK` fields), nested bulleted
 * and numbered lists, simple tables (`colspan` / `rowspan`), line breaks,
 * tabs, footnotes / endnotes and embedded PNG / JPEG / GIF / WebP images as
 * data URLs. The result goes through `sanitizeImportedHtml`.
 *
 * Tracked changes are imported as if accepted (`w:ins` kept, `w:del` dropped)
 * unless `trackedChanges: "original"` is passed. Text boxes, charts, shapes,
 * equations, comments and page layout are not imported.
 */

export const DOCX_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.document.macroenabled.12",
] as const;

export interface DocxImportOptions {
  /** Adapter id (default `"docx"`). */
  id?: string;
  /**
   * `DOMParser` constructor used to read the XML parts. Defaults to the global
   * one (browsers, jsdom); pass e.g. jsdom's or `@xmldom/xmldom`'s in Node.
   */
  DOMParser?: { new (): DOMParser };
  /**
   * Tracked changes: `"accepted"` (default) imports insertions and drops
   * deletions; `"original"` does the opposite (as if all were rejected).
   */
  trackedChanges?: "accepted" | "original";
  /** Embed images from `word/media` as data URLs (default `true`). */
  images?: boolean;
  /** Images larger than this many bytes are skipped (default 10 MiB). */
  maxImageSize?: number;
  /** Limits for reading the DOCX container (default: 100 MiB extracted, 5 000 entries). */
  zip?: ZipReadOptions;
}

export const DEFAULT_DOCX_MAX_IMAGE_SIZE = 10 * 1024 * 1024;

const W_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

interface Format {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sup?: boolean;
  sub?: boolean;
  href?: string;
}

interface StyleInfo {
  name: string;
  basedOn?: string;
  outlineLevel?: number;
  numPr?: { numId: string; ilvl: number };
  format: Format;
}

interface ListLevel {
  ordered: boolean;
  start: number;
}

interface Numbering {
  abstracts: Map<string, Map<number, ListLevel>>;
  nums: Map<string, { abstractId: string; starts: Map<number, number> }>;
}

/** One XML part (document, footnotes, …) with its relationships and preloaded images. */
interface Part {
  rels: Map<string, Relationship>;
  images: Map<string, string>;
}

interface Note {
  element: Element;
  part: Part;
}

interface RenderContext {
  styles: Map<string, StyleInfo>;
  numbering: Numbering;
  notes: Map<string, Note>;
  /** Note keys (`footnote:1`) in order of first reference. */
  noteOrder: string[];
  tracked: "accepted" | "original";
}

type Segment =
  | { kind: "text"; text: string; format: Format }
  | { kind: "br"; format: Format }
  | { kind: "img"; src: string; alt: string; format: Format }
  | { kind: "note"; n: number; format: Format };

// --- XML helpers -----------------------------------------------------------

function isW(node: Node | null | undefined, localName?: string): node is Element {
  if (!node || node.nodeType !== 1) return false;
  const el = node as Element;
  if (localName !== undefined && el.localName !== localName) return false;
  return W_NAMESPACES.has(el.namespaceURI ?? "") || el.prefix === "w";
}

function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

function wChild(el: Element | undefined | null, localName: string): Element | undefined {
  if (!el) return undefined;
  return childElements(el).find((child) => isW(child, localName));
}

/** Reads an attribute by local name, ignoring its namespace prefix. */
function attr(el: Element | undefined | null, localName: string): string | undefined {
  if (!el) return undefined;
  for (const a of Array.from(el.attributes)) {
    if (a.localName === localName) return a.value;
  }
  return undefined;
}

function descendants(el: Element | Document, localName: string): Element[] {
  return Array.from(el.getElementsByTagName("*")).filter((node) => node.localName === localName);
}

/** `<w:b/>`, `<w:b w:val="true"/>` → true; `<w:b w:val="0"/>` → false; missing → undefined. */
function toggle(el: Element | undefined): boolean | undefined {
  if (!el) return undefined;
  const value = attr(el, "val")?.toLowerCase();
  return value === undefined || !["0", "false", "off", "none"].includes(value);
}

function parseXml(Parser: { new (): DOMParser }, xml: string, partName: string): Document {
  const doc = new Parser().parseFromString(xml, "application/xml");
  if (!doc.documentElement || doc.getElementsByTagName("parsererror").length > 0) {
    throw new ImportError("invalid_file", `DOCX part "${partName}" is not well-formed XML.`);
  }
  return doc;
}

// --- Package helpers -------------------------------------------------------

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

/** Resolves a relationship target against the directory of its source part. */
function resolvePartPath(baseDir: string, target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : baseDir + target;
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function relsPathFor(partPath: string): string {
  return `${dirname(partPath)}_rels/${partPath.slice(dirname(partPath).length)}.rels`;
}

async function readXmlPart(
  zip: ZipArchive,
  Parser: { new (): DOMParser },
  path: string,
): Promise<Document | null> {
  const entry = zip.get(path) ?? zip.entries.find((e) => e.name.toLowerCase() === path.toLowerCase());
  if (!entry) return null;
  return parseXml(Parser, await zip.readText(entry), path);
}

async function readRelationships(
  zip: ZipArchive,
  Parser: { new (): DOMParser },
  partPath: string,
): Promise<Map<string, Relationship>> {
  const rels = new Map<string, Relationship>();
  const doc = await readXmlPart(zip, Parser, relsPathFor(partPath));
  if (!doc) return rels;
  const baseDir = dirname(partPath);
  descendants(doc, "Relationship").forEach((rel) => {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target") ?? "";
    if (!id) return;
    const external = attr(rel, "TargetMode")?.toLowerCase() === "external";
    rels.set(id, {
      type: attr(rel, "Type") ?? "",
      target: external ? target : resolvePartPath(baseDir, target),
      external,
    });
  });
  return rels;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** Preloads the images a part references, keyed by relationship id. */
async function loadImages(
  zip: ZipArchive,
  root: Document,
  rels: Map<string, Relationship>,
  options: DocxImportOptions,
): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  if (options.images === false) return images;
  const maxSize = options.maxImageSize ?? DEFAULT_DOCX_MAX_IMAGE_SIZE;
  const ids = new Set<string>();
  descendants(root, "blip").forEach((blip) => {
    const id = attr(blip, "embed");
    if (id) ids.add(id);
  });
  descendants(root, "imagedata").forEach((data) => {
    const id = attr(data, "id");
    if (id) ids.add(id);
  });
  for (const id of ids) {
    const rel = rels.get(id);
    // Linked (external) images are never fetched.
    if (!rel || rel.external) continue;
    const mime = IMAGE_MIME_TYPES[rel.target.split(".").pop()?.toLowerCase() ?? ""];
    const entry = zip.get(rel.target);
    if (!mime || !entry || entry.size > maxSize) continue;
    images.set(id, `data:${mime};base64,${toBase64(await zip.read(entry))}`);
  }
  return images;
}

// --- Styles and numbering ---------------------------------------------------

function readFormat(rPr: Element | undefined): Format {
  const format: Format = {};
  if (!rPr) return format;
  const set = (key: keyof Format, value: boolean | undefined) => {
    if (value !== undefined) (format as Record<string, unknown>)[key] = value;
  };
  set("b", toggle(wChild(rPr, "b")));
  set("i", toggle(wChild(rPr, "i")));
  set("u", toggle(wChild(rPr, "u")));
  const strike = toggle(wChild(rPr, "strike"));
  const dstrike = toggle(wChild(rPr, "dstrike"));
  if (strike !== undefined || dstrike !== undefined) format.s = !!(strike || dstrike);
  const vertAlign = attr(wChild(rPr, "vertAlign"), "val");
  if (vertAlign) {
    format.sup = vertAlign === "superscript";
    format.sub = vertAlign === "subscript";
  }
  return format;
}

function readNumPr(pPr: Element | undefined): { numId: string; ilvl: number } | undefined {
  const numPr = wChild(pPr, "numPr");
  if (!numPr) return undefined;
  const numId = attr(wChild(numPr, "numId"), "val");
  if (numId === undefined) return undefined;
  return { numId, ilvl: Number(attr(wChild(numPr, "ilvl"), "val") ?? 0) || 0 };
}

function readStyles(doc: Document | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!doc) return styles;
  descendants(doc, "style").forEach((style) => {
    const id = attr(style, "styleId");
    if (!id) return;
    const pPr = wChild(style, "pPr");
    const outline = attr(wChild(pPr, "outlineLvl"), "val");
    styles.set(id, {
      name: attr(wChild(style, "name"), "val") ?? id,
      basedOn: attr(wChild(style, "basedOn"), "val"),
      outlineLevel: outline !== undefined ? Number(outline) : undefined,
      numPr: readNumPr(pPr),
      format: readFormat(wChild(style, "rPr")),
    });
  });
  return styles;
}

function styleChain(styles: Map<string, StyleInfo>, id: string | undefined): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const style = styles.get(id);
    if (!style) break;
    chain.push(style);
    id = style.basedOn;
  }
  return chain;
}

/** Heading level (1–6) of a paragraph style, from its name, id or outline level. */
function styleHeadingLevel(styles: Map<string, StyleInfo>, id: string | undefined): number | undefined {
  if (id && /^heading([1-6])$/i.test(id)) return Number(id.slice(-1));
  for (const style of styleChain(styles, id)) {
    const byName = /^heading\s*([1-6])$/i.exec(style.name);
    if (byName) return Number(byName[1]);
    if (/^title$/i.test(style.name)) return 1;
    if (style.outlineLevel !== undefined) {
      return style.outlineLevel >= 0 && style.outlineLevel <= 5 ? style.outlineLevel + 1 : undefined;
    }
  }
  if (id && /^title$/i.test(id)) return 1;
  return undefined;
}

function readNumbering(doc: Document | null): Numbering {
  const numbering: Numbering = { abstracts: new Map(), nums: new Map() };
  if (!doc) return numbering;
  descendants(doc, "abstractNum").forEach((abstract) => {
    const id = attr(abstract, "abstractNumId");
    if (id === undefined) return;
    const levels = new Map<number, ListLevel>();
    childElements(abstract)
      .filter((el) => isW(el, "lvl"))
      .forEach((lvl) => {
        const format = attr(wChild(lvl, "numFmt"), "val") ?? "bullet";
        levels.set(Number(attr(lvl, "ilvl") ?? 0), {
          ordered: format !== "bullet" && format !== "none",
          start: Number(attr(wChild(lvl, "start"), "val") ?? 1) || 1,
        });
      });
    numbering.abstracts.set(id, levels);
  });
  descendants(doc, "num").forEach((num) => {
    const id = attr(num, "numId");
    const abstractId = attr(wChild(num, "abstractNumId"), "val");
    if (id === undefined || abstractId === undefined) return;
    const starts = new Map<number, number>();
    childElements(num)
      .filter((el) => isW(el, "lvlOverride"))
      .forEach((override) => {
        const start = attr(wChild(override, "startOverride"), "val");
        if (start !== undefined) starts.set(Number(attr(override, "ilvl") ?? 0), Number(start));
      });
    numbering.nums.set(id, { abstractId, starts });
  });
  return numbering;
}

// --- Rendering --------------------------------------------------------------

const formatKey = (f: Format) =>
  `${f.b ? 1 : 0}${f.i ? 1 : 0}${f.u ? 1 : 0}${f.s ? 1 : 0}${f.sup ? 1 : 0}${f.sub ? 1 : 0}|${f.href ?? ""}`;

function wrapFormat(inner: string, f: Format): string {
  let html = inner;
  if (f.sup) html = `<sup>${html}</sup>`;
  else if (f.sub) html = `<sub>${html}</sub>`;
  if (f.s) html = `<s>${html}</s>`;
  if (f.u) html = `<u>${html}</u>`;
  if (f.i) html = `<em>${html}</em>`;
  if (f.b) html = `<strong>${html}</strong>`;
  if (f.href) html = `<a href="${escapeHtml(f.href)}">${html}</a>`;
  return html;
}

function renderSegments(segments: Segment[]): string {
  let html = "";
  let i = 0;
  while (i < segments.length) {
    const key = formatKey(segments[i].format);
    let inner = "";
    let j = i;
    for (; j < segments.length && formatKey(segments[j].format) === key; j++) {
      const seg = segments[j];
      if (seg.kind === "text") inner += escapeHtml(seg.text);
      else if (seg.kind === "br") inner += "<br>";
      else if (seg.kind === "img") inner += `<img src="${escapeHtml(seg.src)}" alt="${escapeHtml(seg.alt)}">`;
      else inner += `<sup>${seg.n}</sup>`;
    }
    html += wrapFormat(inner, segments[i].format);
    i = j;
  }
  return html;
}

function parseHyperlinkInstruction(instr: string): string | undefined {
  const match = /^\s*HYPERLINK\b(.*)$/i.exec(instr);
  if (!match) return undefined;
  const rest = match[1];
  const anchor = /\\l\s+"([^"]*)"/.exec(rest)?.[1];
  const target = /^\s*(?:"([^"]*)"|([^\s\\]+))/.exec(rest);
  const url = target?.[1] ?? target?.[2];
  if (url) return anchor ? `${url}#${anchor}` : url;
  return anchor ? `#${anchor}` : undefined;
}

class ParagraphRenderer {
  private segments: Segment[] = [];
  /** Open complex fields (`w:fldChar`), innermost last. */
  private fields: { instr: string; href?: string; separated: boolean }[] = [];

  constructor(
    private readonly ctx: RenderContext,
    private readonly part: Part,
  ) {}

  render(p: Element): string {
    this.walk(p, {});
    return renderSegments(this.segments);
  }

  private fieldHref(): string | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) {
      if (this.fields[i].separated && this.fields[i].href) return this.fields[i].href;
    }
    return undefined;
  }

  private inFieldInstruction(): boolean {
    return this.fields.some((field) => !field.separated);
  }

  private walk(el: Element, base: Format) {
    const accepted = this.ctx.tracked === "accepted";
    for (const child of childElements(el)) {
      if (!isW(child)) {
        // Markup-compatibility wrappers (e.g. around drawings) are handled per run.
        continue;
      }
      switch (child.localName) {
        case "r":
          this.run(child, base);
          break;
        case "hyperlink": {
          const relId = attr(child, "id");
          const rel = relId ? this.part.rels.get(relId) : undefined;
          const anchor = attr(child, "anchor");
          const href = rel ? rel.target + (anchor ? `#${anchor}` : "") : anchor ? `#${anchor}` : undefined;
          this.walk(child, href ? { ...base, href } : base);
          break;
        }
        case "fldSimple": {
          const href = parseHyperlinkInstruction(attr(child, "instr") ?? "");
          this.walk(child, href ? { ...base, href } : base);
          break;
        }
        case "ins":
        case "moveTo":
          if (accepted) this.walk(child, base);
          break;
        case "del":
        case "moveFrom":
          if (!accepted) this.walk(child, base);
          break;
        case "sdt":
          this.walk(wChild(child, "sdtContent") ?? child, base);
          break;
        case "smartTag":
        case "customXml":
        case "dir":
        case "bdo":
        case "sdtContent":
          this.walk(child, base);
          break;
        default:
          break;
      }
    }
  }

  private run(r: Element, base: Format) {
    const rPr = wChild(r, "rPr");
    const styleFormat = this.ctx.styles.get(attr(wChild(rPr, "rStyle"), "val") ?? "")?.format ?? {};
    const own = readFormat(rPr);
    const format: Format = { ...base, ...styleFormat, ...own };
    for (const child of childElements(r)) {
      this.runChild(child, format);
    }
  }

  private runChild(child: Element, format: Format) {
    const push = (segment: Segment) => {
      if (this.inFieldInstruction()) return;
      const href = format.href ?? this.fieldHref();
      this.segments.push(href && !format.href ? { ...segment, format: { ...format, href } } : segment);
    };
    if (child.localName === "AlternateContent") {
      // Prefer the first branch that yields an image (mc:Choice, then mc:Fallback).
      const branch = childElements(child).find(
        (b) => descendants(b, "blip").length || descendants(b, "imagedata").length,
      );
      if (branch) this.image(branch, format, push);
      return;
    }
    if (!isW(child)) return;
    switch (child.localName) {
      case "t":
        push({ kind: "text", text: child.textContent ?? "", format });
        break;
      case "delText":
        if (this.ctx.tracked === "original") push({ kind: "text", text: child.textContent ?? "", format });
        break;
      case "tab":
      case "ptab":
        push({ kind: "text", text: "\t", format });
        break;
      case "br": {
        const type = attr(child, "type");
        if (type !== "page" && type !== "column") push({ kind: "br", format });
        break;
      }
      case "cr":
        push({ kind: "br", format });
        break;
      case "noBreakHyphen":
        push({ kind: "text", text: "‑", format });
        break;
      case "drawing":
      case "pict":
      case "object":
        this.image(child, format, push);
        break;
      case "footnoteReference":
      case "endnoteReference": {
        const kind = child.localName === "footnoteReference" ? "footnote" : "endnote";
        const key = `${kind}:${attr(child, "id")}`;
        if (!this.ctx.notes.has(key)) break;
        let index = this.ctx.noteOrder.indexOf(key);
        if (index === -1) index = this.ctx.noteOrder.push(key) - 1;
        push({ kind: "note", n: index + 1, format: { ...format, sup: false, sub: false } });
        break;
      }
      case "fldChar": {
        const type = attr(child, "fldCharType");
        if (type === "begin") this.fields.push({ instr: "", separated: false });
        else if (type === "separate") {
          const field = this.fields[this.fields.length - 1];
          if (field) {
            field.separated = true;
            field.href = parseHyperlinkInstruction(field.instr);
          }
        } else if (type === "end") this.fields.pop();
        break;
      }
      case "instrText": {
        const field = this.fields[this.fields.length - 1];
        if (field && !field.separated) field.instr += child.textContent ?? "";
        break;
      }
      default:
        break;
    }
  }

  private image(container: Element, format: Format, push: (segment: Segment) => void) {
    const blip = descendants(container, "blip")[0];
    const imageData = descendants(container, "imagedata")[0];
    const id = blip ? attr(blip, "embed") : attr(imageData, "id");
    const src = id ? this.part.images.get(id) : undefined;
    if (!src) return;
    const docPr = descendants(container, "docPr")[0];
    const alt = attr(docPr, "descr") || attr(docPr, "title") || attr(imageData, "title") || "";
    push({ kind: "img", src, alt, format });
  }
}

/** Flattens block-level wrappers (content controls, tracked moves, …) into `w:p` / `w:tbl`. */
function flattenBlocks(container: Element, ctx: RenderContext, out: Element[] = []): Element[] {
  const accepted = ctx.tracked === "accepted";
  for (const child of childElements(container)) {
    if (!isW(child)) continue;
    switch (child.localName) {
      case "p":
      case "tbl":
        out.push(child);
        break;
      case "sdt":
        flattenBlocks(wChild(child, "sdtContent") ?? child, ctx, out);
        break;
      case "sdtContent":
      case "customXml":
        flattenBlocks(child, ctx, out);
        break;
      case "ins":
      case "moveTo":
        if (accepted) flattenBlocks(child, ctx, out);
        break;
      case "del":
      case "moveFrom":
        if (!accepted) flattenBlocks(child, ctx, out);
        break;
      default:
        break;
    }
  }
  return out;
}

function paragraphInfo(p: Element, ctx: RenderContext) {
  const pPr = wChild(p, "pPr");
  const styleId = attr(wChild(pPr, "pStyle"), "val");
  const outline = attr(wChild(pPr, "outlineLvl"), "val");
  let heading: number | undefined;
  if (outline !== undefined) {
    const level = Number(outline);
    heading = level >= 0 && level <= 5 ? level + 1 : undefined;
  } else {
    heading = styleHeadingLevel(ctx.styles, styleId);
  }
  let numPr = readNumPr(pPr);
  if (!numPr) numPr = styleChain(ctx.styles, styleId).find((style) => style.numPr)?.numPr;
  let list: { level: number; ordered: boolean; start: number } | undefined;
  if (numPr && numPr.numId !== "0" && heading === undefined) {
    const num = ctx.numbering.nums.get(numPr.numId);
    const def = num ? ctx.numbering.abstracts.get(num.abstractId)?.get(numPr.ilvl) : undefined;
    list = {
      level: Math.max(0, Math.min(numPr.ilvl, 8)),
      ordered: def?.ordered ?? false,
      start: num?.starts.get(numPr.ilvl) ?? def?.start ?? 1,
    };
  }
  return { heading, list };
}

function renderBlocks(container: Element, ctx: RenderContext, part: Part): string {
  let html = "";
  // Open lists, outermost first; each has an open `<li>`.
  const stack: { level: number; tag: "ul" | "ol" }[] = [];
  const closeList = () => {
    const top = stack.pop()!;
    html += `</li></${top.tag}>`;
  };
  const closeAll = () => {
    while (stack.length) closeList();
  };

  for (const block of flattenBlocks(container, ctx)) {
    if (block.localName === "tbl") {
      closeAll();
      html += renderTable(block, ctx, part);
      continue;
    }
    const { heading, list } = paragraphInfo(block, ctx);
    const inner = new ParagraphRenderer(ctx, part).render(block);
    const blockHtml = heading ? `<h${heading}>${inner}</h${heading}>` : `<p>${inner}</p>`;
    if (!list) {
      closeAll();
      html += blockHtml;
      continue;
    }
    const tag = list.ordered ? "ol" : "ul";
    while (stack.length && stack[stack.length - 1].level > list.level) closeList();
    const top = stack[stack.length - 1];
    if (top && top.level === list.level && top.tag === tag) {
      html += "</li><li>";
    } else {
      if (top && top.level === list.level) closeList();
      const start = tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      html += `<${tag}${start}><li>`;
      stack.push({ level: list.level, tag });
    }
    html += blockHtml;
  }
  closeAll();
  return html;
}

function renderTable(tbl: Element, ctx: RenderContext, part: Part): string {
  type Cell = { el: Element; col: number; span: number; merge?: "restart" | "continue"; header: boolean };
  const rows: Cell[][] = [];
  const collectRows = (container: Element) => {
    for (const child of childElements(container)) {
      if (isW(child, "tr")) {
        const header = !!toggle(wChild(wChild(child, "trPr"), "tblHeader"));
        const cells: Cell[] = [];
        let col = 0;
        const collectCells = (row: Element) => {
          for (const cellEl of childElements(row)) {
            if (isW(cellEl, "tc")) {
              const tcPr = wChild(cellEl, "tcPr");
              const span = Math.max(1, Number(attr(wChild(tcPr, "gridSpan"), "val") ?? 1) || 1);
              const vMerge = wChild(tcPr, "vMerge");
              const merge = vMerge ? (attr(vMerge, "val") === "restart" ? "restart" : "continue") : undefined;
              cells.push({ el: cellEl, col, span, merge, header });
              col += span;
            } else if (isW(cellEl, "sdt")) {
              collectCells(wChild(cellEl, "sdtContent") ?? cellEl);
            }
          }
        };
        collectCells(child);
        rows.push(cells);
      } else if (isW(child, "sdt")) {
        collectRows(wChild(child, "sdtContent") ?? child);
      }
    }
  };
  collectRows(tbl);

  let html = "<table><tbody>";
  rows.forEach((cells, rowIndex) => {
    html += "<tr>";
    for (const cell of cells) {
      if (cell.merge === "continue") continue;
      let rowspan = 1;
      if (cell.merge === "restart") {
        for (let r = rowIndex + 1; r < rows.length; r++) {
          const below = rows[r].find((c) => c.col === cell.col);
          if (below?.merge !== "continue") break;
          rowspan++;
        }
      }
      const tag = cell.header ? "th" : "td";
      const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}`;
      html += `<${tag}${attrs}>${renderBlocks(cell.el, ctx, part) || "<p></p>"}</${tag}>`;
    }
    html += "</tr>";
  });
  return `${html}</tbody></table>`;
}

function getDomParser(options: DocxImportOptions): { new (): DOMParser } {
  const Parser = options.DOMParser ?? (globalThis as any).DOMParser ?? (globalThis as any).window?.DOMParser;
  if (typeof Parser !== "function") {
    throw new ImportError(
      "unsupported_environment",
      "DOCX import needs a DOMParser. In Node, pass one with createDocxImportAdapter({ DOMParser }) (e.g. from jsdom).",
    );
  }
  return Parser;
}

/**
 * Converts a DOCX file to sanitized TipTap HTML and plain text. Throws
 * {@link ImportError} (`invalid_file` / `unsupported_environment`) or
 * `ZipError` for damaged or oversized containers.
 */
export async function docxToDocumentImport(
  data: ArrayBuffer | ArrayBufferView,
  options: DocxImportOptions = {},
): Promise<DocumentImport> {
  const Parser = getDomParser(options);
  let zip: ZipArchive;
  try {
    zip = await readZip(data, { maxTotalSize: 100 * 1024 * 1024, maxEntries: 5_000, ...options.zip });
  } catch (error) {
    if ((error as { code?: string })?.code === "invalid_archive") {
      throw new ImportError("invalid_file", "Not a DOCX file (the file is not a ZIP package).", { cause: error });
    }
    throw error;
  }

  let mainPath = "word/document.xml";
  const packageRels = await readXmlPart(zip, Parser, "_rels/.rels");
  if (packageRels) {
    const office = descendants(packageRels, "Relationship").find((rel) =>
      /\/officeDocument$/.test(attr(rel, "Type") ?? ""),
    );
    const target = attr(office, "Target");
    if (target) mainPath = resolvePartPath("", target);
  }
  const documentXml = await readXmlPart(zip, Parser, mainPath);
  const body = documentXml ? descendants(documentXml, "body").find((el) => isW(el)) : undefined;
  if (!documentXml || !body) {
    throw new ImportError("invalid_file", "Not a Word document (no main document part with a body).");
  }

  const rels = await readRelationships(zip, Parser, mainPath);
  const partByType = (suffix: string) =>
    Array.from(rels.values()).find((rel) => !rel.external && rel.type.endsWith(`/${suffix}`))?.target;
  const baseDir = dirname(mainPath);
  const stylesPath = partByType("styles") ?? `${baseDir}styles.xml`;
  const numberingPath = partByType("numbering") ?? `${baseDir}numbering.xml`;

  const ctx: RenderContext = {
    styles: readStyles(await readXmlPart(zip, Parser, stylesPath)),
    numbering: readNumbering(await readXmlPart(zip, Parser, numberingPath)),
    notes: new Map(),
    noteOrder: [],
    tracked: options.trackedChanges ?? "accepted",
  };

  for (const kind of ["footnote", "endnote"] as const) {
    const path = partByType(`${kind}s`) ?? `${baseDir}${kind}s.xml`;
    const notesXml = await readXmlPart(zip, Parser, path);
    if (!notesXml) continue;
    const noteRels = await readRelationships(zip, Parser, path);
    const part: Part = { rels: noteRels, images: await loadImages(zip, notesXml, noteRels, options) };
    descendants(notesXml, kind)
      .filter((note) => isW(note))
      .forEach((note) => {
        const type = attr(note, "type");
        if (type && type !== "normal") return; // separators
        ctx.notes.set(`${kind}:${attr(note, "id")}`, { element: note, part });
      });
  }

  const part: Part = { rels, images: await loadImages(zip, documentXml, rels, options) };
  let html = renderBlocks(body, ctx, part);
  if (ctx.noteOrder.length) {
    // Notes may reference further notes; render until the list stops growing.
    let notesHtml = "";
    for (let i = 0; i < ctx.noteOrder.length; i++) {
      const note = ctx.notes.get(ctx.noteOrder[i])!;
      notesHtml += `<li>${renderBlocks(note.element, ctx, note.part) || "<p></p>"}</li>`;
    }
    html += `<hr><ol>${notesHtml}</ol>`;
  }
  const sanitized = sanitizeImportedHtml(html);
  return { html: sanitized, text: htmlToPlainText(sanitized) };
}

/** Creates a DOCX `document` adapter with custom options. */
export function createDocxImportAdapter(options: DocxImportOptions = {}): DocumentImportAdapter {
  return {
    id: options.id ?? "docx",
    label: "Word document",
    mimeTypes: DOCX_MIME_TYPES,
    extensions: [".docx", ".docm", ".dotx"],
    target: "document",
    async import(_input, context) {
      return docxToDocumentImport(await context.readArrayBuffer(), options);
    },
  };
}

/** DOCX adapter with default options; registered in the default registry. */
export const docxImportAdapter: DocumentImportAdapter = createDocxImportAdapter();
