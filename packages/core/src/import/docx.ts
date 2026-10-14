// Portions ported from wordcraft/crates/docx/src/read/mod.rs and wordcraft/crates/docx/src/read/story.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { sanitizeImportedHtml } from "../serializers/html";
import { escapeHtml, htmlToPlainText } from "../serializers/plain-text";
import { createReviewId, type CommentReply, type CommentThread, type SerializedComments } from "../extensions/comment-store";
import {
  createStyleRegistry,
  DEFAULT_STYLES,
  isValidStyleId,
  NORMAL_STYLE_ID,
  type CharacterFormat,
  type ParagraphFormat,
  type StyleDefinition,
} from "../extensions/paragraph-styles/registry";
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
 * unless `trackedChanges: "original"` is passed; `trackedChanges: "marks"`
 * keeps them as track-changes marks (`<ins>` / `<del>` with authors, dates and
 * move ids, formatting changes from `w:rPrChange`, block changes from
 * `w:pPrChange`).
 *
 * Comments (`comments.xml`, with replies and resolved state from
 * `commentsExtended.xml` and author ids from `people.xml`) are returned as
 * `comments`, and their ranges are marked with `data-comment-id`. The
 * paragraph and character styles of `styles.xml` are returned as a style
 * registry (`styles`), and body paragraphs with a custom style get
 * `data-style`. Paragraphs in the `Block Text` style become block quotes, and
 * paragraphs in the `Code` style code blocks. Text boxes, charts, shapes,
 * equations and page layout are not imported.
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
   * deletions; `"original"` does the opposite (as if all were rejected);
   * `"marks"` keeps both as track-changes marks (for editors with `TrackChanges`).
   */
  trackedChanges?: "accepted" | "original" | "marks";
  /** Import comments and mark their ranges (default `true`). */
  comments?: boolean;
  /** Return the file's styles as `styles` and add `data-style` to styled paragraphs (default `true`). */
  paragraphStyles?: boolean;
  /** Embed images from `word/media` as data URLs (default `true`). */
  images?: boolean;
  /** Images larger than this many bytes are skipped (default 10 MiB). */
  maxImageSize?: number;
  /** Limits for reading the DOCX container (default: 100 MiB extracted, 5 000 entries). */
  zip?: ZipReadOptions;
}

export const DEFAULT_DOCX_MAX_IMAGE_SIZE = 10 * 1024 * 1024;
/** Most comments (threads plus replies) read from one file. */
const MAX_COMMENTS = 5_000;
/** Longest reply chain followed to find a thread's root. */
const MAX_PARENT_CHAIN = 64;

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

/** Glyphs the DOCX export writes before task list items (Word has no checklist numbering). */
const TASK_GLYPHS: Record<string, boolean> = { "☐": false, "☒": true, "☑": true };

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
  /** Tracked insertion or deletion (`trackedChanges: "marks"`). */
  rev?: RevisionInfo;
  /** Tracked formatting change (`w:rPrChange`). */
  fmt?: FormatChangeInfo;
  /** Ids of the comment threads covering the text. */
  comments?: string[];
}

interface ChangeInfo {
  changeId: string;
  authorId: string;
  authorName: string;
  createdAt: number;
}

interface RevisionInfo extends ChangeInfo {
  kind: "insertion" | "deletion";
  moveId?: string;
}

interface FormatChangeInfo extends ChangeInfo {
  before: { type: string }[];
  after: { type: string }[];
}

interface StyleInfo {
  name: string;
  type: string;
  basedOn?: string;
  next?: string;
  link?: string;
  priority?: number;
  quick?: boolean;
  hidden?: boolean;
  outlineLevel?: number;
  numPr?: { numId: string; ilvl: number };
  format: Format;
  paragraph: ParagraphFormat;
  character: CharacterFormat;
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
  tracked: "accepted" | "original" | "marks";
  /** File style id → registry style id (empty with `paragraphStyles: false`). */
  styleIds: Map<string, string>;
  /** Author name → user id (`people.xml`). */
  people: Map<string, string>;
  /** Comment file id → thread id (replies map to their thread). */
  commentThreads: Map<string, string>;
  /** Open comment ranges: thread id → number of open ranges. */
  openComments: Map<string, number>;
  /** Open move ranges by range id, latest last. */
  moveRanges: Map<string, { moveId: string; to: boolean }>;
  /** Move names (`w:name`) → move ids unique to this import. */
  moveIds: Map<string, string>;
  /** Segments emitted so far; adjacent changes by the same author and time share an id. */
  segmentCount: number;
  lastChange: { key: string; changeId: string; end: number } | null;
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

/** Twips → CSS points. */
function twipsToCss(value: string | undefined): string | undefined {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? `${Math.round((n / 20) * 100) / 100}pt` : undefined;
}

const ALIGNMENTS: Record<string, ParagraphFormat["textAlign"]> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  distribute: "justify",
};

function readParagraphFormat(pPr: Element | undefined): ParagraphFormat {
  const format: ParagraphFormat = {};
  if (!pPr) return format;
  const jc = attr(wChild(pPr, "jc"), "val");
  if (jc && ALIGNMENTS[jc]) format.textAlign = ALIGNMENTS[jc];
  const spacing = wChild(pPr, "spacing");
  const before = twipsToCss(attr(spacing, "before"));
  const after = twipsToCss(attr(spacing, "after"));
  if (before) format.spaceBefore = before;
  if (after) format.spaceAfter = after;
  const line = Number(attr(spacing, "line"));
  if (Number.isFinite(line) && line > 0) {
    const rule = attr(spacing, "lineRule") ?? "auto";
    format.lineHeight = rule === "auto" ? String(Math.round((line / 240) * 100) / 100) : twipsToCss(String(line));
  }
  const ind = wChild(pPr, "ind");
  const left = twipsToCss(attr(ind, "left") ?? attr(ind, "start"));
  const right = twipsToCss(attr(ind, "right") ?? attr(ind, "end"));
  const first = attr(ind, "firstLine");
  const hanging = attr(ind, "hanging");
  if (left) format.indentLeft = left;
  if (right) format.indentRight = right;
  if (first !== undefined) format.indentFirstLine = twipsToCss(first);
  else if (hanging !== undefined && Number.isFinite(Number(hanging))) format.indentFirstLine = twipsToCss(String(-Number(hanging)));
  return format;
}

function readCharacterFormat(rPr: Element | undefined): CharacterFormat {
  const format: CharacterFormat = {};
  if (!rPr) return format;
  const f = readFormat(rPr);
  if (f.b !== undefined) format.bold = f.b;
  if (f.i !== undefined) format.italic = f.i;
  if (f.u !== undefined) format.underline = f.u;
  if (f.s !== undefined) format.strike = f.s;
  const fonts = wChild(rPr, "rFonts");
  const font = attr(fonts, "ascii") ?? attr(fonts, "hAnsi");
  // Style values end up in a stylesheet; only plain font names are kept.
  if (font && /^[\w .-]{1,64}$/.test(font)) format.fontFamily = font;
  const size = Number(attr(wChild(rPr, "sz"), "val"));
  if (Number.isFinite(size) && size > 0 && size < 3300) format.fontSize = `${size / 2}pt`;
  const color = attr(wChild(rPr, "color"), "val");
  if (color && /^[0-9a-f]{6}$/i.test(color)) format.color = `#${color.toLowerCase()}`;
  if (toggle(wChild(rPr, "caps"))) format.textTransform = "uppercase";
  const smallCaps = toggle(wChild(rPr, "smallCaps"));
  if (smallCaps !== undefined) format.smallCaps = smallCaps;
  return format;
}

function readStyles(doc: Document | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!doc) return styles;
  descendants(doc, "style").forEach((style) => {
    const id = attr(style, "styleId");
    if (!id) return;
    const pPr = wChild(style, "pPr");
    const rPr = wChild(style, "rPr");
    const outline = attr(wChild(pPr, "outlineLvl"), "val");
    const priority = Number(attr(wChild(style, "uiPriority"), "val"));
    styles.set(id, {
      name: attr(wChild(style, "name"), "val") ?? id,
      type: attr(style, "type") ?? "paragraph",
      basedOn: attr(wChild(style, "basedOn"), "val"),
      next: attr(wChild(style, "next"), "val"),
      link: attr(wChild(style, "link"), "val"),
      priority: Number.isFinite(priority) && attr(wChild(style, "uiPriority"), "val") !== undefined ? priority : undefined,
      quick: toggle(wChild(style, "qFormat")),
      hidden: toggle(wChild(style, "semiHidden")) || toggle(wChild(style, "hidden")),
      outlineLevel: outline !== undefined ? Number(outline) : undefined,
      numPr: readNumPr(pPr),
      format: readFormat(rPr),
      paragraph: readParagraphFormat(pPr),
      character: readCharacterFormat(rPr),
    });
  });
  return styles;
}

/** Word stores some built-in style names in lower case (`heading 1`). */
function displayStyleName(name: string): string {
  const heading = /^heading ([1-9])$/.exec(name);
  return heading ? `Heading ${heading[1]}` : name;
}

/** Maps file style ids to valid, unique registry ids (`Überschrift1` → `berschrift1`). */
function mapStyleIds(styles: Map<string, StyleInfo>): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  styles.forEach((style, fileId) => {
    if (style.type !== "paragraph" && style.type !== "character") return;
    let id = fileId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    if (!/^[A-Za-z]/.test(id)) id = `S${id}`;
    let unique = id;
    for (let n = 2; used.has(unique); n++) unique = `${id}${n}`;
    if (!isValidStyleId(unique)) return;
    used.add(unique);
    ids.set(fileId, unique);
  });
  return ids;
}

const styleKind = (style: StyleInfo | undefined) => (style?.type === "character" ? "character" : "paragraph");

/** The file's paragraph and character styles as registry definitions. */
function styleDefinitions(styles: Map<string, StyleInfo>, ids: Map<string, string>): StyleDefinition[] {
  const out: StyleDefinition[] = [];
  styles.forEach((style, fileId) => {
    const id = ids.get(fileId);
    if (!id) return;
    const kind = styleKind(style);
    const sameKind = (other: string | undefined) =>
      other && ids.has(other) && styleKind(styles.get(other)) === kind ? ids.get(other) : undefined;
    const definition: StyleDefinition = { id, name: displayStyleName(style.name || fileId), kind };
    const basedOn = sameKind(style.basedOn);
    if (basedOn) definition.basedOn = basedOn;
    if (kind === "paragraph") {
      const next = sameKind(style.next);
      if (next) definition.next = next;
    }
    const linked = style.link ? ids.get(style.link) : undefined;
    if (linked) definition.linked = linked;
    if (kind === "paragraph" && Object.keys(style.paragraph).length) definition.paragraph = style.paragraph;
    if (Object.keys(style.character).length) definition.character = style.character;
    if (kind === "paragraph") {
      const heading = /^heading([1-6])$/i.exec(fileId) ?? /^heading ([1-6])$/i.exec(style.name);
      if (heading) definition.block = { type: "heading", attrs: { level: Number(heading[1]) } };
      else if (style.outlineLevel !== undefined && style.outlineLevel >= 0 && style.outlineLevel <= 5) {
        definition.block = { type: "heading", attrs: { level: style.outlineLevel + 1 } };
      } else if (id === "Code") definition.block = { type: "codeBlock" };
      else if (id === NORMAL_STYLE_ID) definition.block = { type: "paragraph" };
    }
    if (style.priority !== undefined) definition.priority = style.priority;
    if (style.quick) definition.quick = true;
    if (style.hidden) definition.hidden = true;
    // Built-in styles keep their identity (and block) when the file redefines them.
    const builtin = DEFAULT_STYLES.find((s) => s.id === id && s.kind === kind);
    if (builtin) {
      definition.builtin = true;
      definition.block ??= builtin.block;
    }
    out.push(definition);
  });
  return out;
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

/** `quote` for Block Text paragraphs, `code` for Code paragraphs (the DOCX export's mapping). */
function specialStyle(styles: Map<string, StyleInfo>, id: string | undefined): "quote" | "code" | undefined {
  if (!id) return undefined;
  for (const style of styleChain(styles, id)) {
    if (/^block ?text$/i.test(style.name)) return "quote";
    if (/^code$/i.test(style.name)) return "code";
  }
  if (/^blocktext$/i.test(id)) return "quote";
  if (id === "Code") return "code";
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

// --- Review data (comments, people, changes) ---------------------------------

function readPeople(doc: Document | null): Map<string, string> {
  const people = new Map<string, string>();
  if (!doc) return people;
  descendants(doc, "person").forEach((person) => {
    const author = attr(person, "author");
    const userId = attr(descendants(person, "presenceInfo")[0], "userId");
    if (author && userId && !people.has(author)) people.set(author, userId);
  });
  return people;
}

function dateOf(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function authorOf(ctx: { people: Map<string, string> }, name: string | undefined) {
  const authorName = (name ?? "").trim() || "Unknown";
  return { id: ctx.people.get(authorName) ?? authorName, name: authorName };
}

/** Plain text of a comment body: paragraphs joined with newlines. */
function commentBody(comment: Element): string {
  const lines: string[] = [];
  const walk = (el: Element, line: string[]) => {
    for (const child of childElements(el)) {
      if (!isW(child)) continue;
      switch (child.localName) {
        case "t":
          line.push(child.textContent ?? "");
          break;
        case "tab":
          line.push("\t");
          break;
        case "br":
        case "cr":
          line.push("\n");
          break;
        case "delText":
        case "del":
        case "moveFrom":
          break;
        default:
          walk(child, line);
      }
    }
  };
  for (const block of childElements(comment)) {
    if (!isW(block)) continue;
    const paragraphs = block.localName === "p" ? [block] : descendants(block, "p").filter((p) => isW(p));
    for (const p of paragraphs) {
      const line: string[] = [];
      walk(p, line);
      lines.push(line.join(""));
    }
  }
  return lines.join("\n").trim();
}

/**
 * Reads `comments.xml` and `commentsExtended.xml` into threads: comments
 * without a parent are threads; replies (`w15:paraIdParent`) are attached to
 * the root of their chain, oldest first. Returns the threads and the map from
 * comment file ids to thread ids.
 */
function readComments(
  commentsXml: Document | null,
  extendedXml: Document | null,
  people: Map<string, string>,
): { threads: CommentThread[]; byFileId: Map<string, string> } {
  const byFileId = new Map<string, string>();
  if (!commentsXml) return { threads: [], byFileId };
  type Entry = { fileId: string; author: ReturnType<typeof authorOf>; createdAt: number; body: string; parent?: string; done: boolean };
  const entries = new Map<string, Entry>();
  const byParaId = new Map<string, string>();
  for (const comment of descendants(commentsXml, "comment").filter((el) => isW(el))) {
    if (entries.size >= MAX_COMMENTS) break;
    const fileId = attr(comment, "id");
    if (fileId === undefined || entries.has(fileId)) continue;
    entries.set(fileId, {
      fileId,
      author: authorOf({ people }, attr(comment, "author")),
      createdAt: dateOf(attr(comment, "date")),
      body: commentBody(comment),
      done: false,
    });
    const paragraphs = descendants(comment, "p");
    const paraId = attr(paragraphs[paragraphs.length - 1], "paraId");
    if (paraId) byParaId.set(paraId, fileId);
  }
  if (extendedXml) {
    for (const ex of descendants(extendedXml, "commentEx")) {
      const fileId = byParaId.get(attr(ex, "paraId") ?? "");
      const entry = fileId !== undefined ? entries.get(fileId) : undefined;
      if (!entry) continue;
      const parent = byParaId.get(attr(ex, "paraIdParent") ?? "");
      if (parent !== undefined && parent !== fileId) entry.parent = parent;
      const done = attr(ex, "done");
      entry.done = done === "1" || done === "true";
    }
  }
  const rootOf = (entry: Entry): Entry => {
    let current = entry;
    for (let i = 0; i < MAX_PARENT_CHAIN && current.parent !== undefined; i++) {
      const parent = entries.get(current.parent);
      if (!parent || parent === entry) break;
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, CommentThread>();
  for (const entry of entries.values()) {
    if (rootOf(entry) !== entry) continue;
    const id = createReviewId("comment");
    byFileId.set(entry.fileId, id);
    threads.set(entry.fileId, {
      id,
      anchor: null,
      author: entry.author,
      createdAt: entry.createdAt,
      body: entry.body,
      replies: [],
      resolved: entry.done,
      orphaned: false,
    });
  }
  for (const entry of entries.values()) {
    const root = rootOf(entry);
    if (root === entry) continue;
    const thread = threads.get(root.fileId);
    if (!thread) continue;
    byFileId.set(entry.fileId, thread.id);
    const reply: CommentReply = {
      id: createReviewId("reply"),
      author: entry.author,
      body: entry.body,
      createdAt: entry.createdAt,
    };
    thread.replies.push(reply);
  }
  return { threads: Array.from(threads.values()), byFileId };
}

/** Applies a range marker (comment or move range) found between runs or blocks. */
function applyMarker(el: Element, ctx: RenderContext): boolean {
  switch (el.localName) {
    case "commentRangeStart": {
      const thread = ctx.commentThreads.get(attr(el, "id") ?? "");
      if (thread) ctx.openComments.set(thread, (ctx.openComments.get(thread) ?? 0) + 1);
      return true;
    }
    case "commentRangeEnd": {
      const thread = ctx.commentThreads.get(attr(el, "id") ?? "");
      const open = thread ? ctx.openComments.get(thread) : undefined;
      if (thread && open !== undefined) {
        if (open <= 1) ctx.openComments.delete(thread);
        else ctx.openComments.set(thread, open - 1);
      }
      return true;
    }
    case "moveFromRangeStart":
    case "moveToRangeStart": {
      const id = attr(el, "id");
      const name = attr(el, "name") ?? `range-${id}`;
      let moveId = ctx.moveIds.get(name);
      if (!moveId) {
        moveId = createReviewId("move");
        ctx.moveIds.set(name, moveId);
      }
      if (id !== undefined) {
        ctx.moveRanges.delete(id);
        ctx.moveRanges.set(id, { moveId, to: el.localName === "moveToRangeStart" });
      }
      return true;
    }
    case "moveFromRangeEnd":
    case "moveToRangeEnd":
      ctx.moveRanges.delete(attr(el, "id") ?? "");
      return true;
    default:
      return false;
  }
}

const FORMAT_MARK_TYPES: [keyof Format, string][] = [
  ["b", "bold"],
  ["i", "italic"],
  ["u", "underline"],
  ["s", "strike"],
  ["sub", "subscript"],
  ["sup", "superscript"],
];

const formatMarks = (f: Format) => FORMAT_MARK_TYPES.filter(([key]) => f[key]).map(([, type]) => ({ type }));

// --- Rendering --------------------------------------------------------------

const formatKey = (f: Format) =>
  `${f.b ? 1 : 0}${f.i ? 1 : 0}${f.u ? 1 : 0}${f.s ? 1 : 0}${f.sup ? 1 : 0}${f.sub ? 1 : 0}|${f.href ?? ""}` +
  (f.rev ? `|${f.rev.kind}:${f.rev.changeId}:${f.rev.moveId ?? ""}` : "") +
  (f.fmt ? `|f:${f.fmt.changeId}` : "") +
  (f.comments ? `|c:${f.comments.join(",")}` : "");

function changeAttrs(change: ChangeInfo): string {
  return (
    ` data-change-id="${escapeHtml(change.changeId)}" data-author-id="${escapeHtml(change.authorId)}"` +
    ` data-author-name="${escapeHtml(change.authorName)}" data-created-at="${change.createdAt}"`
  );
}

function wrapFormat(inner: string, f: Format): string {
  let html = inner;
  if (f.sup) html = `<sup>${html}</sup>`;
  else if (f.sub) html = `<sub>${html}</sub>`;
  if (f.s) html = `<s>${html}</s>`;
  if (f.u) html = `<u>${html}</u>`;
  if (f.i) html = `<em>${html}</em>`;
  if (f.b) html = `<strong>${html}</strong>`;
  if (f.fmt) {
    html =
      `<span data-change-type="format"${changeAttrs(f.fmt)}` +
      ` data-format-before="${escapeHtml(JSON.stringify(f.fmt.before))}" data-format-after="${escapeHtml(JSON.stringify(f.fmt.after))}">${html}</span>`;
  }
  if (f.rev) {
    const tag = f.rev.kind === "insertion" ? "ins" : "del";
    const move = f.rev.moveId ? ` data-move-id="${escapeHtml(f.rev.moveId)}"` : "";
    html = `<${tag} data-change-type="${f.rev.kind}"${changeAttrs(f.rev)}${move}>${html}</${tag}>`;
  }
  for (const id of [...(f.comments ?? [])].reverse()) html = `<span data-comment-id="${escapeHtml(id)}">${html}</span>`;
  if (f.href) html = `<a href="${escapeHtml(f.href)}">${html}</a>`;
  return html;
}

function renderSegments(segments: Segment[], code = false): string {
  let html = "";
  let i = 0;
  while (i < segments.length) {
    const key = formatKey(segments[i].format);
    let inner = "";
    let j = i;
    for (; j < segments.length && formatKey(segments[j].format) === key; j++) {
      const seg = segments[j];
      if (seg.kind === "text") inner += escapeHtml(seg.text);
      else if (seg.kind === "br") inner += code ? "\n" : "<br>";
      else if (seg.kind === "img") inner += code ? "" : `<img src="${escapeHtml(seg.src)}" alt="${escapeHtml(seg.alt)}">`;
      else inner += `<sup>${seg.n}</sup>`;
    }
    const format = segments[i].format;
    // Code blocks hold plain text: only review marks are kept.
    html += wrapFormat(inner, code ? { rev: format.rev, comments: format.comments } : format);
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
  segments: Segment[] = [];
  /** Open complex fields (`w:fldChar`), innermost last. */
  private fields: { instr: string; href?: string; separated: boolean }[] = [];

  constructor(
    private readonly ctx: RenderContext,
    private readonly part: Part,
  ) {}

  collect(p: Element): this {
    this.walk(p, {});
    return this;
  }

  render(p: Element): string {
    return this.collect(p).html();
  }

  html(code = false): string {
    return renderSegments(this.segments, code);
  }

  /** Removes a leading task-list glyph (`☐ ` / `☒ `) and returns its checked state. */
  takeTaskGlyph(): boolean | undefined {
    const first = this.segments[0];
    if (!first || first.kind !== "text") return undefined;
    const glyph = first.text.charAt(0);
    if (!(glyph in TASK_GLYPHS)) return undefined;
    const rest = first.text.slice(1).replace(/^ /, "");
    if (rest) first.text = rest;
    else {
      this.segments.shift();
      const next = this.segments[0];
      if (next?.kind === "text") {
        next.text = next.text.replace(/^ /, "");
        if (!next.text) this.segments.shift();
      }
    }
    return TASK_GLYPHS[glyph];
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

  /** A tracked change id shared with the previous change when adjacent and by the same author at the same time. */
  private changeId(key: string): string {
    const last = this.ctx.lastChange;
    if (last && last.key === key && last.end === this.ctx.segmentCount) return last.changeId;
    return createReviewId("change");
  }

  private change(el: Element, kind: string, extra = ""): { info: ChangeInfo; key: string } {
    const author = authorOf(this.ctx, attr(el, "author"));
    const createdAt = dateOf(attr(el, "date"));
    const key = `${kind}|${author.name}|${createdAt}|${extra}`;
    return {
      key,
      info: { changeId: this.changeId(key), authorId: author.id, authorName: author.name, createdAt },
    };
  }

  private revision(el: Element, kind: RevisionInfo["kind"]): { rev: RevisionInfo; key: string } {
    let moveId: string | undefined;
    if (el.localName === "moveFrom" || el.localName === "moveTo") {
      const to = el.localName === "moveTo";
      for (const range of this.ctx.moveRanges.values()) if (range.to === to) moveId = range.moveId;
      moveId ??= createReviewId("move");
    }
    const { info, key } = this.change(el, kind, moveId ?? "");
    return { rev: { ...info, kind, ...(moveId ? { moveId } : {}) }, key };
  }

  private walkChange(el: Element, base: Format, kind: RevisionInfo["kind"]) {
    const { rev, key } = this.revision(el, kind);
    this.walk(el, { ...base, rev });
    this.ctx.lastChange = { key, changeId: rev.changeId, end: this.ctx.segmentCount };
  }

  private walk(el: Element, base: Format) {
    const tracked = this.ctx.tracked;
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
          if (tracked === "accepted") this.walk(child, base);
          else if (tracked === "marks") this.walkChange(child, base, "insertion");
          break;
        case "del":
        case "moveFrom":
          if (tracked === "original") this.walk(child, base);
          else if (tracked === "marks") this.walkChange(child, base, "deletion");
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
          applyMarker(child, this.ctx);
          break;
      }
    }
  }

  private run(r: Element, base: Format) {
    const rPr = wChild(r, "rPr");
    const runStyle = this.ctx.styles.get(attr(wChild(rPr, "rStyle"), "val") ?? "");
    // The Hyperlink character style only says "this is a link": its underline is not formatting.
    const styleFormat = base.href && runStyle && /^hyperlink$/i.test(runStyle.name) ? {} : (runStyle?.format ?? {});
    const own = readFormat(rPr);
    const format: Format = { ...base, ...styleFormat, ...own };
    const rPrChange = wChild(rPr, "rPrChange");
    let changeKey: string | undefined;
    if (rPrChange && this.ctx.tracked === "marks") {
      const { info, key } = this.change(rPrChange, "format");
      const before = { ...styleFormat, ...readFormat(wChild(rPrChange, "rPr")) };
      format.fmt = { ...info, before: formatMarks(before), after: formatMarks(format) };
      changeKey = key;
    }
    for (const child of childElements(r)) {
      this.runChild(child, format);
    }
    if (format.fmt && changeKey) {
      this.ctx.lastChange = { key: changeKey, changeId: format.fmt.changeId, end: this.ctx.segmentCount };
    }
  }

  private runChild(child: Element, format: Format) {
    const push = (segment: Segment) => {
      if (this.inFieldInstruction()) return;
      const href = format.href ?? this.fieldHref();
      let out = href && !format.href ? { ...segment, format: { ...format, href } } : segment;
      if (this.ctx.openComments.size) {
        out = { ...out, format: { ...out.format, comments: Array.from(this.ctx.openComments.keys()) } };
      }
      this.segments.push(out);
      this.ctx.segmentCount++;
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
        if (this.ctx.tracked !== "accepted") push({ kind: "text", text: child.textContent ?? "", format });
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

const MARKERS = new Set([
  "commentRangeStart",
  "commentRangeEnd",
  "moveFromRangeStart",
  "moveFromRangeEnd",
  "moveToRangeStart",
  "moveToRangeEnd",
]);

/**
 * Flattens block-level wrappers (content controls, tracked moves, …) into
 * `w:p` / `w:tbl`, keeping block-level range markers in document order.
 */
function flattenBlocks(container: Element, ctx: RenderContext, out: Element[] = []): Element[] {
  const tracked = ctx.tracked;
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
        if (tracked !== "original") flattenBlocks(child, ctx, out);
        break;
      case "del":
      case "moveFrom":
        if (tracked !== "accepted") flattenBlocks(child, ctx, out);
        break;
      default:
        if (MARKERS.has(child.localName)) out.push(child);
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
  const special = heading === undefined && !list ? specialStyle(ctx.styles, styleId) : undefined;
  return { heading, list, styleId, special, pPr };
}

/** `data-block-change` for a paragraph with `w:pPrChange` (top-level paragraphs, `trackedChanges: "marks"`). */
function blockChangeAttr(pPr: Element | undefined, ctx: RenderContext): string {
  const change = wChild(pPr, "pPrChange");
  if (!change) return "";
  const oldPPr = wChild(change, "pPr");
  const oldStyle = attr(wChild(oldPPr, "pStyle"), "val");
  const oldOutline = attr(wChild(oldPPr, "outlineLvl"), "val");
  const level =
    oldOutline !== undefined
      ? Number(oldOutline) >= 0 && Number(oldOutline) <= 5
        ? Number(oldOutline) + 1
        : undefined
      : styleHeadingLevel(ctx.styles, oldStyle);
  const mappedStyle = oldStyle ? ctx.styleIds.get(oldStyle) : undefined;
  const previous =
    level !== undefined
      ? { type: "heading", attrs: { level }, wrappers: [] }
      : specialStyle(ctx.styles, oldStyle) === "code"
        ? { type: "codeBlock", attrs: {}, wrappers: [] }
        : { type: "paragraph", attrs: mappedStyle && mappedStyle !== NORMAL_STYLE_ID ? { styleId: mappedStyle } : {}, wrappers: [] };
  const author = authorOf(ctx, attr(change, "author"));
  const record = {
    changeId: createReviewId("change"),
    authorId: author.id,
    authorName: author.name,
    authorColor: null,
    createdAt: dateOf(attr(change, "date")),
    previous,
  };
  return ` data-block-change="${escapeHtml(JSON.stringify(record))}"`;
}

function renderBlocks(container: Element, ctx: RenderContext, part: Part, topLevel = false): string {
  let html = "";
  // Open lists, outermost first; each has an open `<li>`.
  const stack: { level: number; tag: "ul" | "ol"; task: boolean }[] = [];
  const closeList = () => {
    const top = stack.pop()!;
    html += `</li></${top.tag}>`;
  };
  const closeAll = () => {
    while (stack.length) closeList();
  };
  // Consecutive Block Text paragraphs form one quote, consecutive Code paragraphs one code block.
  let group: { kind: "quote" | "code"; parts: string[] } | null = null;
  const flush = () => {
    if (!group) return;
    html += group.kind === "quote" ? `<blockquote>${group.parts.join("")}</blockquote>` : `<pre><code>${group.parts.join("\n")}</code></pre>`;
    group = null;
  };

  for (const block of flattenBlocks(container, ctx)) {
    if (MARKERS.has(block.localName)) {
      applyMarker(block, ctx);
      continue;
    }
    if (block.localName === "tbl") {
      closeAll();
      flush();
      html += renderTable(block, ctx, part);
      continue;
    }
    const { heading, list, styleId, special, pPr } = paragraphInfo(block, ctx);
    const renderer = new ParagraphRenderer(ctx, part).collect(block);
    if (special) {
      closeAll();
      if (group && (group as { kind: string }).kind !== special) flush();
      group ??= { kind: special, parts: [] };
      group.parts.push(special === "code" ? renderer.html(true) : `<p>${renderer.html()}</p>`);
      continue;
    }
    flush();
    const task = list && !list.ordered ? renderer.takeTaskGlyph() : undefined;
    const inner = renderer.html();
    const mappedStyle = styleId ? ctx.styleIds.get(styleId) : undefined;
    const styleAttr =
      !heading && !list && mappedStyle && mappedStyle !== NORMAL_STYLE_ID ? ` data-style="${escapeHtml(mappedStyle)}"` : "";
    const changeAttr = topLevel && !list && ctx.tracked === "marks" ? blockChangeAttr(pPr, ctx) : "";
    const blockHtml = heading
      ? `<h${heading}${changeAttr}>${inner}</h${heading}>`
      : `<p${styleAttr}${changeAttr}>${inner}</p>`;
    if (!list) {
      closeAll();
      html += blockHtml;
      continue;
    }
    const tag = list.ordered ? "ol" : "ul";
    const isTask = task !== undefined;
    const item = isTask ? `<li data-type="taskItem" data-checked="${task ? "true" : "false"}">` : "<li>";
    while (stack.length && stack[stack.length - 1].level > list.level) closeList();
    const top = stack[stack.length - 1];
    if (top && top.level === list.level && top.tag === tag && top.task === isTask) {
      html += `</li>${item}`;
    } else {
      if (top && top.level === list.level) closeList();
      const start = tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      const type = isTask ? ' data-type="taskList"' : "";
      html += `<${tag}${type}${start}>${item}`;
      stack.push({ level: list.level, tag, task: isTask });
    }
    html += blockHtml;
  }
  closeAll();
  flush();
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
 * Converts a DOCX file to sanitized TipTap HTML and plain text, plus its
 * comments and styles. Throws {@link ImportError} (`invalid_file` /
 * `unsupported_environment`) or `ZipError` for damaged or oversized containers.
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

  const styles = readStyles(await readXmlPart(zip, Parser, stylesPath));
  const useStyles = options.paragraphStyles !== false;
  const styleIds = useStyles ? mapStyleIds(styles) : new Map<string, string>();
  const peoplePath = partByType("people");
  const people = readPeople(peoplePath ? await readXmlPart(zip, Parser, peoplePath) : null);

  let threads: CommentThread[] = [];
  let commentThreads = new Map<string, string>();
  if (options.comments !== false) {
    const commentsPath = partByType("comments");
    const extendedPath = partByType("commentsExtended");
    const read = readComments(
      commentsPath ? await readXmlPart(zip, Parser, commentsPath) : null,
      extendedPath ? await readXmlPart(zip, Parser, extendedPath) : null,
      people,
    );
    threads = read.threads;
    commentThreads = read.byFileId;
  }

  const ctx: RenderContext = {
    styles,
    numbering: readNumbering(await readXmlPart(zip, Parser, numberingPath)),
    notes: new Map(),
    noteOrder: [],
    tracked: options.trackedChanges ?? "accepted",
    styleIds,
    people,
    commentThreads,
    openComments: new Map(),
    moveRanges: new Map(),
    moveIds: new Map(),
    segmentCount: 0,
    lastChange: null,
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
  let html = renderBlocks(body, ctx, part, true);
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
  const result: DocumentImport = { html: sanitized, text: htmlToPlainText(sanitized) };
  if (threads.length) result.comments = { version: 1, threads };
  if (useStyles) {
    const definitions = styleDefinitions(styles, styleIds);
    if (definitions.length) result.styles = createStyleRegistry({ styles: definitions });
  }
  return result;
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
