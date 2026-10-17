// Portions ported from wordcraft/crates/docx/src/write/mod.rs, wordcraft/crates/docx/src/write/story.rs, wordcraft/crates/docx/src/write/props.rs and wordcraft/crates/docx/src/package.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { CHART_OOXML_CONTENT_TYPE, CHART_OOXML_NS, CHART_OOXML_RELATIONSHIP, chartToOoxml } from "../chart/ooxml";
import { normalizeChartSpec } from "../chart/spec";
import type { CommentThread, ReviewAuthor, SerializedComments } from "../extensions/comment-store";
import {
  DEFAULT_STYLES,
  isValidStyleId,
  NORMAL_STYLE_ID,
  type CharacterFormat,
  type ParagraphFormat,
  type StyleDefaults,
  type StyleDefinition,
  type StyleRegistry,
  type StyleRegistryJSON,
} from "../extensions/paragraph-styles/registry";
import { DOCX_IMAGE_CONTENT_TYPES, DOCX_IMAGE_TYPES, decodeDataUrl, imagePixelSize, pixelAttr } from "./images";
import {
  cssColorToHex,
  cssLengthToPt,
  ptToHalfPoints,
  ptToTwips,
  pxToEmu,
  pxToTwips,
  WORD_HIGHLIGHTS,
} from "./units";
import { XmlWriter, type XmlAttrs } from "./xml";
import { writeZip, type ZipWriteEntry } from "./zip-writer";

/**
 * Dependency-free DOCX (WordprocessingML) export of TipTap documents.
 *
 * Takes an editor (anything with `getJSON()`) or its JSON and writes a
 * minimal, valid package: `[Content_Types].xml`, `_rels/.rels`,
 * `word/document.xml` (+ relationships), `styles.xml` (from the paragraph
 * style registry, with `basedOn` / `next` / `link`), `numbering.xml` (one
 * `w:num` per list), `settings.xml`, `comments.xml` +
 * `commentsExtended.xml` (replies and resolved state) + `people.xml` (author
 * ids), `docProps/core.xml` and `docProps/app.xml`, plus embedded images and
 * charts (`chart` nodes become native Word charts in `word/charts/chartN.xml`;
 * inline `sparkline` nodes are written as text: their label, or ▁▃▇ bars).
 *
 * Tracked insertions, deletions, moves (`w:moveFrom` / `w:moveTo` with
 * named move ranges), formatting changes (`w:rPrChange`) and block changes
 * (`w:pPrChange`, paragraph-mark `w:ins` / `w:del`) keep their authors and
 * dates. Anything that cannot be written is listed in the returned report.
 */

export const DOCX_EXPORT_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A ProseMirror / TipTap JSON node (`editor.getJSON()`). */
export interface DocxJSONNode {
  type?: string;
  attrs?: Record<string, any>;
  content?: DocxJSONNode[];
  marks?: DocxJSONMark[];
  text?: string;
}

export interface DocxJSONMark {
  type: string;
  attrs?: Record<string, any>;
}

/** Anything with `getJSON()`, e.g. a TipTap `Editor`. Its comment store and style registry are used by default. */
export interface DocxExportEditorLike {
  getJSON(): DocxJSONNode;
  storage?: unknown;
}

/** A comment store (`CommentStore`), its `toJSON()` output, or a thread list. */
export type DocxCommentSource =
  | { toJSON(): SerializedComments }
  | { getSnapshot(): { threads: readonly CommentThread[] } }
  | SerializedComments
  | readonly CommentThread[];

export interface DocxExportOptions {
  /**
   * Paragraph and character styles written to `styles.xml`. Defaults to the
   * editor's registry (`ParagraphStyles` extension), else the built-in styles.
   */
  styles?: StyleRegistry | StyleRegistryJSON | readonly StyleDefinition[];
  /** Comment threads. Defaults to the editor's comment store (`Comments` extension). */
  comments?: DocxCommentSource | null;
  /**
   * The document's author (`dc:creator`) and the author of tracked changes
   * and comments that name none.
   */
  author?: string | ReviewAuthor;
  /**
   * `"strip-authors"` writes every comment, reply and tracked change as
   * "Author" (initials "A"), leaves out `people.xml`, the creator and last
   * modified by, and sets `w:removePersonalInformation` so Word keeps doing
   * so. Default `"keep"`.
   */
  privacy?: "keep" | "strip-authors";
  /** `dc:title` of the document. */
  title?: string;
  /**
   * Images with `http(s)` URLs: `"skip"` (default, reported) or `"link"`
   * (an external relationship Word may load when the file is opened).
   */
  remoteImages?: "skip" | "link";
  /** Time written as created / modified (default: now). */
  now?: () => Date;
  /** ZIP compression (default `"auto"`: deflate when `CompressionStream` exists). */
  compression?: "auto" | "store";
}

export type DocxExportIssueKind = "node" | "mark" | "image" | "link" | "comment" | "style";

/** Something the export left out or simplified, counted per kind, name and reason. */
export interface DocxExportIssue {
  kind: DocxExportIssueKind;
  /** Node / mark type, style id, image or link URL (truncated), or comment thread id. */
  name: string;
  reason: string;
  count: number;
}

export interface DocxExportReport {
  /** Content that was dropped or simplified. Empty when everything was written. */
  dropped: DocxExportIssue[];
  /** Counts of what was written. */
  written: {
    paragraphs: number;
    tables: number;
    images: number;
    /** `chart` nodes written as native Word charts. */
    charts: number;
    comments: number;
    replies: number;
    trackedChanges: number;
  };
}

export interface DocxExportResult {
  /** The `.docx` file. */
  data: Uint8Array;
  report: DocxExportReport;
}

export interface DocxPackagePart {
  name: string;
  data: Uint8Array | string;
}

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
};

const BODY_NS: XmlAttrs = {
  "xmlns:w": NS.w,
  "xmlns:r": NS.r,
  "xmlns:wp": NS.wp,
  "xmlns:a": NS.a,
  "xmlns:pic": NS.pic,
  "xmlns:mc": NS.mc,
  "xmlns:w14": NS.w14,
  "xmlns:w15": NS.w15,
  "mc:Ignorable": "w14 w15",
};

const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
  settings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
  comments: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  commentsExtended: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  people: "http://schemas.microsoft.com/office/2011/relationships/people",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
};

const CT_WML = "application/vnd.openxmlformats-officedocument.wordprocessingml.";

/** Text width of a US Letter page with 1" margins, in twips (6.5"). */
const CONTENT_WIDTH_TWIPS = 9360;
/** Widest image, in CSS pixels (6.5" at 96 dpi). */
const MAX_IMAGE_WIDTH_PX = 624;
/** Indent per list or quote level, in twips (0.5"). */
const INDENT_STEP = 720;
/** Name written for every author with `privacy: "strip-authors"` (as Word does). */
export const DOCX_ANONYMOUS_AUTHOR = "Author";
const ANONYMOUS_INITIALS = "A";
const MAX_DEPTH = 64;

/** Bullet characters per list level. */
const BULLETS = ["•", "◦", "▪"];
const BULLET_FONTS = ["Symbol", "Courier New", "Wingdings"];
const TASK_UNCHECKED = "☐";
const TASK_CHECKED = "☒";

/** Formatting marks whose `rPr` is written; the rest are reported. */
const FORMAT_MARKS = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "subscript",
  "superscript",
  "code",
  "textStyle",
  "highlight",
  "characterStyle",
]);
/** Marks handled separately (links, review) or that carry no formatting. */
const STRUCTURAL_MARKS = new Set(["link", "insertion", "deletion", "formatChange", "comment", "bookmark"]);

interface RunFormat {
  charStyle?: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  color?: string;
  halfPoints?: number;
  highlight?: string;
  shading?: string;
  underline?: boolean;
  vertAlign?: "superscript" | "subscript";
}

interface Revision {
  kind: "ins" | "del";
  attrs: Record<string, any>;
  moveId?: string;
}

type PieceKind = "text" | "tab" | "br" | "image";

interface Piece {
  kind: PieceKind;
  text?: string;
  node: DocxJSONNode;
  /** Last piece produced by `node` (comment range ends go after it). */
  last: boolean;
  marks: DocxJSONMark[];
}

interface BlockContext {
  depth: number;
  quoteLevel: number;
  list?: { numId: number; level: number; task?: boolean; checked?: boolean };
  /** The list item's first paragraph gets the number; later ones are indented. */
  listItemFirst?: boolean;
}

interface BlockChangeRecord {
  changeId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: number;
  previous?: { type?: string; attrs?: Record<string, any> };
  operation?: "insert" | "delete";
}

const isEditorLike = (value: unknown): value is DocxExportEditorLike =>
  !!value && typeof (value as DocxExportEditorLike).getJSON === "function";

/** Threads from any supported comment source. */
function threadsOf(source: DocxCommentSource | null | undefined): CommentThread[] {
  if (!source) return [];
  if (Array.isArray(source)) return [...source];
  const value = source as any;
  if (typeof value.toJSON === "function") return [...(value.toJSON()?.threads ?? [])];
  if (typeof value.getSnapshot === "function") return [...(value.getSnapshot()?.threads ?? [])];
  return Array.isArray(value.threads) ? [...value.threads] : [];
}

function stylesOf(source: DocxExportOptions["styles"]): { styles: StyleDefinition[]; defaults: StyleDefaults } {
  if (!source) return { styles: DEFAULT_STYLES.map((s) => ({ ...s })), defaults: {} };
  if (Array.isArray(source)) return { styles: [...source], defaults: {} };
  const value = source as any;
  const json: StyleRegistryJSON = typeof value.toJSON === "function" ? value.toJSON() : value;
  return { styles: [...(json.styles ?? [])], defaults: json.defaults ?? {} };
}

function authorOf(author: DocxExportOptions["author"]): ReviewAuthor | undefined {
  if (!author) return undefined;
  return typeof author === "string" ? { id: author, name: author } : author;
}

/** W3CDTF date without milliseconds, or `undefined` for missing / invalid times. */
function isoDate(ms: unknown): string | undefined {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return letters || ANONYMOUS_INITIALS;
}

/** Word keeps built-in style names in lower case (`heading 1`) in `styles.xml`. */
function fileStyleName(name: string): string {
  const heading = /^Heading ([1-9])$/.exec(name);
  return heading ? `heading ${heading[1]}` : name;
}

const truncate = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Converts a mark list to run formatting. */
function runFormatOf(marks: readonly DocxJSONMark[] | undefined): RunFormat {
  const format: RunFormat = {};
  for (const mark of marks ?? []) {
    const attrs = mark.attrs ?? {};
    switch (mark.type) {
      case "bold":
        format.bold = true;
        break;
      case "italic":
        format.italic = true;
        break;
      case "underline":
        format.underline = true;
        break;
      case "strike":
        format.strike = true;
        break;
      case "subscript":
        format.vertAlign = "subscript";
        break;
      case "superscript":
        format.vertAlign = "superscript";
        break;
      case "code":
        format.font = "Consolas";
        break;
      case "textStyle": {
        const color = cssColorToHex(attrs.color);
        if (color) format.color = color;
        const pt = cssLengthToPt(attrs.fontSize);
        if (pt !== undefined && pt > 0) format.halfPoints = ptToHalfPoints(pt);
        if (typeof attrs.fontFamily === "string" && attrs.fontFamily.trim()) {
          format.font = attrs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
        }
        break;
      }
      case "highlight": {
        const color = attrs.color ? cssColorToHex(attrs.color) : "FFFF00";
        if (color && WORD_HIGHLIGHTS[color]) format.highlight = WORD_HIGHLIGHTS[color];
        else if (color) format.shading = color;
        break;
      }
      case "characterStyle":
        if (isValidStyleId(attrs.styleId)) format.charStyle = attrs.styleId;
        break;
      case "link":
        format.charStyle ??= "Hyperlink";
        break;
      default:
        break;
    }
  }
  return format;
}

/** `w:rPr` children in CT_RPr order. */
function writeRunProps(w: XmlWriter, f: RunFormat): void {
  if (f.charStyle) w.val("w:rStyle", f.charStyle);
  if (f.font) w.empty("w:rFonts", { "w:ascii": f.font, "w:hAnsi": f.font, "w:cs": f.font, "w:eastAsia": f.font });
  if (f.bold) w.empty("w:b");
  if (f.italic) w.empty("w:i");
  if (f.strike) w.empty("w:strike");
  if (f.color) w.val("w:color", f.color);
  if (f.halfPoints) {
    w.val("w:sz", f.halfPoints);
    w.val("w:szCs", f.halfPoints);
  }
  if (f.highlight) w.val("w:highlight", f.highlight);
  if (f.underline) w.val("w:u", "single");
  if (f.shading) w.empty("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": f.shading });
  if (f.vertAlign) w.val("w:vertAlign", f.vertAlign);
}

const hasRunProps = (f: RunFormat) => Object.values(f).some((v) => v !== undefined && v !== false);

function characterFormatToRun(c: CharacterFormat | undefined): RunFormat {
  const f: RunFormat = {};
  if (!c) return f;
  if (c.fontFamily) f.font = c.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (c.bold) f.bold = true;
  if (c.italic) f.italic = true;
  if (c.underline) f.underline = true;
  if (c.strike) f.strike = true;
  const color = cssColorToHex(c.color);
  if (color) f.color = color;
  const pt = cssLengthToPt(c.fontSize);
  if (pt !== undefined && pt > 0) f.halfPoints = ptToHalfPoints(pt);
  const background = cssColorToHex(c.backgroundColor);
  if (background) f.shading = background;
  return f;
}

/** `w:pPr` content of a style's paragraph format (spacing, indentation, alignment). */
function writeParagraphFormat(w: XmlWriter, p: ParagraphFormat | undefined, outline?: number): void {
  if (!p && outline === undefined) return;
  const before = cssLengthToPt(p?.spaceBefore);
  const after = cssLengthToPt(p?.spaceAfter);
  const lineValue = p?.lineHeight;
  let line: number | undefined;
  let lineRule: string | undefined;
  if (typeof lineValue === "string" && /^\s*\d+(\.\d+)?\s*$/.test(lineValue)) {
    line = Math.round(Number(lineValue) * 240);
    lineRule = "auto";
  } else if (lineValue) {
    const pt = cssLengthToPt(lineValue);
    if (pt !== undefined && pt > 0) {
      line = ptToTwips(pt);
      lineRule = "atLeast";
    }
  }
  if (before !== undefined || after !== undefined || line !== undefined) {
    w.empty("w:spacing", {
      "w:before": before !== undefined ? Math.max(0, ptToTwips(before)) : undefined,
      "w:after": after !== undefined ? Math.max(0, ptToTwips(after)) : undefined,
      "w:line": line,
      "w:lineRule": lineRule,
    });
  }
  const left = cssLengthToPt(p?.indentLeft);
  const right = cssLengthToPt(p?.indentRight);
  const first = cssLengthToPt(p?.indentFirstLine);
  if (left !== undefined || right !== undefined || first !== undefined) {
    w.empty("w:ind", {
      "w:left": left !== undefined ? ptToTwips(left) : undefined,
      "w:right": right !== undefined ? ptToTwips(right) : undefined,
      "w:firstLine": first !== undefined && first >= 0 ? ptToTwips(first) : undefined,
      "w:hanging": first !== undefined && first < 0 ? ptToTwips(-first) : undefined,
    });
  }
  const jc = alignment(p?.textAlign);
  if (jc) w.val("w:jc", jc);
  if (outline !== undefined) w.val("w:outlineLvl", outline);
}

function alignment(value: unknown): string | undefined {
  switch (value) {
    case "left":
      return "left";
    case "center":
      return "center";
    case "right":
      return "right";
    case "justify":
      return "both";
    default:
      return undefined;
  }
}

class Relationships {
  private list: { id: string; type: string; target: string; external: boolean }[] = [];
  private index = new Map<string, string>();

  add(type: string, target: string, external = false): string {
    const key = `${type}\n${target}\n${external}`;
    const existing = this.index.get(key);
    if (existing) return existing;
    const id = `rId${this.list.length + 1}`;
    this.list.push({ id, type, target, external });
    this.index.set(key, id);
    return id;
  }

  get size(): number {
    return this.list.length;
  }

  xml(): string {
    const w = new XmlWriter();
    w.open("Relationships", { xmlns: "http://schemas.openxmlformats.org/package/2006/relationships" });
    for (const rel of this.list) {
      w.empty("Relationship", {
        Id: rel.id,
        Type: rel.type,
        Target: rel.target,
        TargetMode: rel.external ? "External" : undefined,
      });
    }
    w.close("Relationships");
    return w.toString();
  }
}

interface CommentEntry {
  thread: CommentThread;
  /** File id of the thread's comment, then of each reply. */
  ids: number[];
  started: boolean;
  ended: boolean;
}

class DocxBuilder {
  readonly report: DocxExportReport = {
    dropped: [],
    written: { paragraphs: 0, tables: 0, images: 0, charts: 0, comments: 0, replies: 0, trackedChanges: 0 },
  };
  private rels = new Relationships();
  private media: { name: string; bytes: Uint8Array }[] = [];
  private mediaTypes = new Set<string>();
  private charts: string[] = [];
  private nums: { numId: number; abstractId: number; start?: number; level: number }[] = [];
  private revisionId = 0;
  private docPrId = 0;
  private paraIdCounter = 0x10000000;
  private comments = new Map<string, CommentEntry>();
  /** Thread id → JSON node carrying its last comment mark. */
  private commentEnds = new Map<string, DocxJSONNode>();
  /** JSON node → threads whose range ends after it (so ends are found in O(1) per node). */
  private endsByNode = new Map<DocxJSONNode, string[]>();
  private people = new Map<string, string>();
  private styleIds: Set<string>;
  private extraStyles = new Set<string>();
  private readonly anonymous: boolean;
  private readonly defaultAuthor: ReviewAuthor | undefined;

  constructor(
    private readonly doc: DocxJSONNode,
    private readonly options: DocxExportOptions,
    private readonly threads: CommentThread[],
    private readonly styles: { styles: StyleDefinition[]; defaults: StyleDefaults },
  ) {
    this.anonymous = options.privacy === "strip-authors";
    this.defaultAuthor = authorOf(options.author);
    this.styleIds = new Set(styles.styles.filter((s) => isValidStyleId(s.id)).map((s) => s.id));
  }

  drop(kind: DocxExportIssueKind, name: string, reason: string): void {
    const issue = this.report.dropped.find((i) => i.kind === kind && i.name === name && i.reason === reason);
    if (issue) issue.count++;
    else this.report.dropped.push({ kind, name: truncate(name), reason, count: 1 });
  }

  // -- Authors and revisions ------------------------------------------------

  private authorName(name: unknown, id: unknown): string {
    if (this.anonymous) return DOCX_ANONYMOUS_AUTHOR;
    const author =
      (typeof name === "string" && name.trim()) ||
      (typeof id === "string" && id.trim()) ||
      this.defaultAuthor?.name ||
      "Unknown";
    const authorId = (typeof id === "string" && id.trim()) || this.defaultAuthor?.id;
    if (authorId && authorId !== author && !this.people.has(author)) this.people.set(author, authorId);
    return author;
  }

  private changeAttrs(attrs: Record<string, any>): XmlAttrs {
    return {
      "w:id": ++this.revisionId,
      "w:author": this.authorName(attrs.authorName, attrs.authorId),
      "w:date": isoDate(attrs.createdAt),
    };
  }

  // -- Comments ---------------------------------------------------------------

  private prepareComments(): void {
    const marked = new Set<string>();
    const visit = (node: DocxJSONNode, depth: number) => {
      if (depth > MAX_DEPTH) return;
      for (const mark of node.marks ?? []) {
        if (mark.type === "comment" && typeof mark.attrs?.commentId === "string") {
          marked.add(mark.attrs.commentId);
          this.commentEnds.set(mark.attrs.commentId, node);
        }
      }
      node.content?.forEach((child) => visit(child, depth + 1));
    };
    visit(this.doc, 0);
    let next = 0;
    for (const thread of this.threads) {
      if (!thread || typeof thread.id !== "string") continue;
      if (!marked.has(thread.id)) {
        this.drop("comment", thread.id, "comment text is not in the document");
        continue;
      }
      if (!thread.body?.trim()) {
        this.drop("comment", thread.id, "draft comment without text");
        this.commentEnds.delete(thread.id);
        continue;
      }
      const replies = (thread.replies ?? []).filter((reply) => reply && reply.body?.trim());
      const ids = [next++, ...replies.map(() => next++)];
      this.comments.set(thread.id, { thread: { ...thread, replies }, ids, started: false, ended: false });
    }
    for (const [threadId, node] of this.commentEnds) {
      if (!this.comments.has(threadId)) continue;
      const list = this.endsByNode.get(node) ?? [];
      list.push(threadId);
      this.endsByNode.set(node, list);
    }
  }

  // -- Document ---------------------------------------------------------------

  documentXml(): string {
    this.prepareComments();
    const body = new XmlWriter(false);
    const blocks = this.doc.type === "doc" || !this.doc.type ? (this.doc.content ?? []) : [this.doc];
    this.blocks(body, blocks, { depth: 0, quoteLevel: 0 });
    // Word wants a paragraph before the section properties.
    if (!blocks.length || blocks[blocks.length - 1].type === "table") body.empty("w:p");
    // Ranges whose end was never written (e.g. text in a dropped node) are closed here.
    for (const [id, entry] of this.comments) if (entry.started && !entry.ended) this.endComment(body, id);
    const w = new XmlWriter();
    w.open("w:document", BODY_NS).open("w:body").raw(body.toString());
    w.open("w:sectPr")
      .empty("w:pgSz", { "w:w": 12240, "w:h": 15840 })
      .empty("w:pgMar", {
        "w:top": 1440,
        "w:right": 1440,
        "w:bottom": 1440,
        "w:left": 1440,
        "w:header": 720,
        "w:footer": 720,
        "w:gutter": 0,
      })
      .close("w:sectPr");
    w.close("w:body").close("w:document");
    return w.toString();
  }

  private blocks(w: XmlWriter, nodes: readonly DocxJSONNode[], ctx: BlockContext): void {
    if (ctx.depth > MAX_DEPTH) {
      this.drop("node", "nesting", `content nested deeper than ${MAX_DEPTH} levels`);
      return;
    }
    let first = true;
    nodes.forEach((node, i) => {
      const itemCtx: BlockContext = { ...ctx, depth: ctx.depth + 1, listItemFirst: ctx.list ? first : undefined };
      this.block(w, node, itemCtx);
      if (node.type !== "bulletList" && node.type !== "orderedList" && node.type !== "taskList") first = false;
      // Two tables in a row would merge into one in Word, so a paragraph separates them.
      if (node.type === "table" && nodes[i + 1]?.type === "table") w.empty("w:p");
    });
  }

  private block(w: XmlWriter, node: DocxJSONNode, ctx: BlockContext): void {
    const type = node.type ?? "";
    switch (type) {
      case "paragraph":
        this.paragraph(w, node, ctx);
        return;
      case "heading":
        this.paragraph(w, node, ctx, { heading: Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)) });
        return;
      case "codeBlock":
        this.paragraph(w, node, ctx, { code: true });
        return;
      case "blockquote":
        this.blocks(w, node.content ?? [], { ...ctx, quoteLevel: ctx.quoteLevel + 1 });
        return;
      case "bulletList":
      case "orderedList":
      case "taskList":
        this.list(w, node, ctx);
        return;
      case "table":
        this.table(w, node, ctx);
        return;
      case "horizontalRule":
        w.open("w:p").open("w:pPr").open("w:pBdr");
        w.empty("w:bottom", { "w:val": "single", "w:sz": 6, "w:space": 1, "w:color": "auto" });
        w.close("w:pBdr").close("w:pPr").close("w:p");
        this.report.written.paragraphs++;
        return;
      case "pageBreak":
        w.open("w:p").open("w:r").empty("w:br", { "w:type": "page" }).close("w:r").close("w:p");
        return;
      case "image":
        this.paragraph(w, { type: "paragraph", content: [node] }, ctx);
        return;
      case "chart":
        this.chartParagraph(w, node, ctx);
        return;
      default:
        break;
    }
    // Unknown blocks: inline content becomes a paragraph, block content is flattened.
    const content = node.content ?? [];
    if (content.some((child) => child.type === "text" || isInlineType(child.type))) {
      this.drop("node", type || "unknown", "written as a plain paragraph");
      this.paragraph(w, { type: "paragraph", content }, ctx);
    } else if (content.length) {
      this.drop("node", type || "unknown", "container flattened");
      this.blocks(w, content, ctx);
    } else {
      this.drop("node", type || "unknown", "unsupported node");
    }
  }

  // -- Lists --------------------------------------------------------------------

  private list(w: XmlWriter, node: DocxJSONNode, ctx: BlockContext): void {
    const level = Math.min(8, ctx.list ? ctx.list.level + 1 : 0);
    const abstractId = node.type === "orderedList" ? 2 : node.type === "taskList" ? 3 : 1;
    const numId = this.nums.length + 1;
    const start = node.type === "orderedList" ? Number(node.attrs?.start ?? 1) : undefined;
    this.nums.push({ numId, abstractId, level, start: start !== undefined && start !== 1 && Number.isFinite(start) ? start : undefined });
    for (const item of node.content ?? []) {
      const task = item.type === "taskItem";
      this.blocks(w, item.content ?? [], {
        ...ctx,
        list: { numId, level, task, checked: task ? !!item.attrs?.checked : undefined },
      });
    }
  }

  // -- Paragraphs -----------------------------------------------------------------

  private styleFor(node: DocxJSONNode, ctx: BlockContext, opts: { heading?: number; code?: boolean }): string | undefined {
    const own = node.attrs?.styleId;
    if (own) {
      if (isValidStyleId(own) && this.styleIds.has(own)) return own;
      this.drop("style", String(own), "style is not in the registry");
    }
    if (opts.heading) return this.needStyle(`Heading${opts.heading}`);
    if (opts.code) return this.needStyle("Code");
    if (ctx.quoteLevel > 0) return this.needStyle("BlockText");
    if (ctx.list) return this.needStyle("ListParagraph");
    return undefined;
  }

  /** Uses a style the registry may not define (it is then written with defaults). */
  private needStyle(id: string): string {
    if (!this.styleIds.has(id)) this.extraStyles.add(id);
    return id;
  }

  private previousStyle(previous: BlockChangeRecord["previous"]): string | undefined {
    if (!previous) return undefined;
    const id = previous.attrs?.styleId;
    if (isValidStyleId(id) && this.styleIds.has(id)) return id;
    if (previous.type === "heading") return this.needStyle(`Heading${Math.max(1, Math.min(6, Number(previous.attrs?.level) || 1))}`);
    if (previous.type === "codeBlock") return this.needStyle("Code");
    return undefined;
  }

  private paragraph(
    w: XmlWriter,
    node: DocxJSONNode,
    ctx: BlockContext,
    opts: { heading?: number; code?: boolean } = {},
  ): void {
    this.report.written.paragraphs++;
    const style = this.styleFor(node, ctx, opts);
    const change = (node.attrs?.blockChange ?? null) as BlockChangeRecord | null;
    const operation = change?.operation;
    const list = ctx.list;
    const numbered = list && ctx.listItemFirst;
    const indent = ctx.quoteLevel * INDENT_STEP + (list && !numbered ? (list.level + 1) * INDENT_STEP : 0);
    const jc = alignment(node.attrs?.textAlign);

    w.open("w:p");
    const ppr = new XmlWriter(false);
    if (style) ppr.val("w:pStyle", style);
    if (numbered) {
      ppr.open("w:numPr").val("w:ilvl", list!.level).val("w:numId", list!.numId).close("w:numPr");
    }
    if (indent && !(ctx.quoteLevel > 0 && !list && ctx.quoteLevel === 1)) ppr.empty("w:ind", { "w:left": indent });
    if (jc) ppr.val("w:jc", jc);
    if (change && operation) {
      ppr.open("w:rPr").empty(operation === "insert" ? "w:ins" : "w:del", this.changeAttrs(change)).close("w:rPr");
      this.report.written.trackedChanges++;
    } else if (change?.previous) {
      ppr.open("w:pPrChange", this.changeAttrs(change)).open("w:pPr");
      const old = this.previousStyle(change.previous);
      if (old) ppr.val("w:pStyle", old);
      const oldJc = alignment(change.previous.attrs?.textAlign);
      if (oldJc) ppr.val("w:jc", oldJc);
      ppr.close("w:pPr").close("w:pPrChange");
      this.report.written.trackedChanges++;
    }
    const pprXml = ppr.toString();
    if (pprXml) w.open("w:pPr").raw(pprXml).close("w:pPr");

    if (list?.task && numbered) {
      // Word has no checklist numbering: the box is the first character.
      w.open("w:r").leaf("w:t", { "xml:space": "preserve" }, `${list.checked ? TASK_CHECKED : TASK_UNCHECKED} `).close("w:r");
    }
    const synthetic: Revision | undefined =
      change && operation ? { kind: operation === "insert" ? "ins" : "del", attrs: change } : undefined;
    this.inline(w, this.pieces(node.content ?? [], opts.code === true), synthetic);
    w.close("w:p");
  }

  /** Flattens inline content into runs of text, tabs, breaks and images. */
  private pieces(nodes: readonly DocxJSONNode[], code: boolean, out: Piece[] = [], depth = 0): Piece[] {
    if (depth > MAX_DEPTH) return out;
    for (const node of nodes) {
      const marks = node.marks ?? [];
      switch (node.type) {
        case "text": {
          const text = node.text ?? "";
          const parts = text.split(/(\t|\r\n|\n|\r)/);
          const pieces: Piece[] = [];
          for (const part of parts) {
            if (!part) continue;
            if (part === "\t") pieces.push({ kind: "tab", node, last: false, marks });
            else if (part === "\n" || part === "\r\n" || part === "\r") pieces.push({ kind: "br", node, last: false, marks });
            else pieces.push({ kind: "text", text: part, node, last: false, marks });
          }
          if (!pieces.length) pieces.push({ kind: "text", text: "", node, last: false, marks });
          pieces[pieces.length - 1].last = true;
          out.push(...pieces);
          break;
        }
        case "hardBreak":
          out.push({ kind: "br", node, last: true, marks });
          break;
        case "image":
          out.push({ kind: "image", node, last: true, marks });
          break;
        case "sparkline": {
          const text = sparklineText(node.attrs);
          this.drop("node", "sparkline", "written as text (its label, or ▁▃▇ bars)");
          out.push({ kind: "text", text, node, last: true, marks });
          break;
        }
        case "mention": {
          const label = node.attrs?.label ?? node.attrs?.id ?? "";
          out.push({ kind: "text", text: label ? `@${label}` : "", node, last: true, marks });
          break;
        }
        default:
          if (node.content?.length) {
            this.pieces(node.content, code, out, depth + 1);
          } else if (typeof node.attrs?.label === "string" || typeof node.attrs?.text === "string") {
            this.drop("node", node.type ?? "unknown", "written as text");
            out.push({ kind: "text", text: String(node.attrs.label ?? node.attrs.text), node, last: true, marks });
          } else {
            this.drop("node", node.type ?? "unknown", "unsupported inline node");
          }
      }
    }
    return out;
  }

  private revisionsOf(marks: readonly DocxJSONMark[], synthetic?: Revision): Revision[] {
    const out: Revision[] = [];
    const ins = marks.find((m) => m.type === "insertion");
    const del = marks.find((m) => m.type === "deletion");
    if (ins) out.push({ kind: "ins", attrs: ins.attrs ?? {}, moveId: ins.attrs?.moveId || undefined });
    if (del) out.push({ kind: "del", attrs: del.attrs ?? {}, moveId: del.attrs?.moveId || undefined });
    if (!out.length && synthetic) out.push(synthetic);
    return out;
  }

  private linkOf(marks: readonly DocxJSONMark[]): string | undefined {
    const link = marks.find((m) => m.type === "link");
    const href = typeof link?.attrs?.href === "string" ? link.attrs.href.trim() : "";
    if (!href) return undefined;
    if (href.startsWith("#") || /^(https?|mailto|tel|ftp):/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    this.drop("link", href, "unsafe URL scheme");
    return undefined;
  }

  /** Writes pieces grouped into hyperlinks (outer) and tracked-change wrappers (inner). */
  private inline(w: XmlWriter, pieces: Piece[], synthetic?: Revision): void {
    let openLink: string | undefined;
    type OpenRevisions = { key: string; tags: string[]; moveRanges: { tag: string; id: number }[] };
    let openRevs: OpenRevisions | null = null;
    const closeRevs = () => {
      const open = openRevs as OpenRevisions | null;
      if (!open) return;
      for (const tag of [...open.tags].reverse()) w.close(tag);
      for (const range of open.moveRanges) w.empty(range.tag, { "w:id": range.id });
      openRevs = null;
    };
    const closeLink = () => {
      closeRevs();
      if (openLink !== undefined) w.close("w:hyperlink");
      openLink = undefined;
    };
    for (const piece of pieces) {
      const href = this.linkOf(piece.marks);
      if (href !== openLink) {
        closeLink();
        if (href !== undefined) {
          if (href.startsWith("#")) w.open("w:hyperlink", { "w:anchor": href.slice(1), "w:history": 1 });
          else w.open("w:hyperlink", { "r:id": this.rels.add(REL.hyperlink, href, true), "w:history": 1 });
          openLink = href;
        }
      }
      const revs = this.revisionsOf(piece.marks, synthetic);
      const key = revs.map((r) => `${r.kind}:${r.attrs.changeId ?? ""}:${r.moveId ?? ""}:${r.attrs.authorName ?? ""}`).join("|");
      if (key !== ((openRevs as OpenRevisions | null)?.key ?? "")) {
        closeRevs();
        if (revs.length) {
          const state: OpenRevisions = { key, tags: [], moveRanges: [] };
          for (const rev of revs) {
            const attrs = this.changeAttrs(rev.attrs);
            this.report.written.trackedChanges++;
            if (rev.moveId) {
              const rangeTag = rev.kind === "ins" ? "w:moveToRange" : "w:moveFromRange";
              const rangeId = ++this.revisionId;
              w.empty(`${rangeTag}Start`, { "w:id": rangeId, "w:name": rev.moveId, "w:author": attrs["w:author"], "w:date": attrs["w:date"] });
              state.moveRanges.push({ tag: `${rangeTag}End`, id: rangeId });
            }
            const tag = rev.moveId ? (rev.kind === "ins" ? "w:moveTo" : "w:moveFrom") : rev.kind === "ins" ? "w:ins" : "w:del";
            w.open(tag, attrs);
            state.tags.push(tag);
          }
          openRevs = state;
        }
      }
      this.commentStarts(w, piece.marks);
      this.run(w, piece, revs);
      if (piece.last) this.commentEndsAfter(w, piece.node);
    }
    closeLink();
  }

  private commentStarts(w: XmlWriter, marks: readonly DocxJSONMark[]): void {
    for (const mark of marks) {
      if (mark.type !== "comment") continue;
      const entry = this.comments.get(mark.attrs?.commentId);
      if (!entry || entry.started) continue;
      entry.started = true;
      for (const id of entry.ids) w.empty("w:commentRangeStart", { "w:id": id });
    }
  }

  private commentEndsAfter(w: XmlWriter, node: DocxJSONNode): void {
    for (const threadId of this.endsByNode.get(node) ?? []) {
      const entry = this.comments.get(threadId);
      if (entry?.started && !entry.ended) this.endComment(w, threadId);
    }
  }

  private endComment(w: XmlWriter, threadId: string): void {
    const entry = this.comments.get(threadId)!;
    entry.ended = true;
    for (const id of entry.ids) {
      w.empty("w:commentRangeEnd", { "w:id": id });
      w.open("w:r").open("w:rPr").val("w:rStyle", "CommentReference").close("w:rPr");
      w.empty("w:commentReference", { "w:id": id }).close("w:r");
    }
    this.needStyle("CommentReference");
    this.needStyle("CommentText");
  }

  private run(w: XmlWriter, piece: Piece, revs: Revision[]): void {
    for (const mark of piece.marks) {
      if (!FORMAT_MARKS.has(mark.type) && !STRUCTURAL_MARKS.has(mark.type)) this.drop("mark", mark.type, "formatting not supported");
      if (mark.type === "characterStyle" && mark.attrs?.styleId && !this.styleIds.has(mark.attrs.styleId)) {
        this.drop("style", String(mark.attrs.styleId), "character style is not in the registry");
      }
    }
    if (piece.kind === "image") {
      const drawing = this.image(piece.node);
      if (!drawing) return;
      w.open("w:r");
      const format = runFormatOf(piece.marks);
      delete format.charStyle;
      if (hasRunProps(format)) {
        w.open("w:rPr");
        writeRunProps(w, format);
        w.close("w:rPr");
      }
      w.raw(drawing).close("w:r");
      return;
    }
    const format = runFormatOf(piece.marks.filter((m) => m.type !== "characterStyle" || this.styleIds.has(m.attrs?.styleId)));
    if (format.charStyle === "Hyperlink") this.needStyle("Hyperlink");
    const formatChange = piece.marks.find((m) => m.type === "formatChange");
    w.open("w:r");
    if (hasRunProps(format) || formatChange) {
      w.open("w:rPr");
      writeRunProps(w, format);
      if (formatChange) {
        const attrs = formatChange.attrs ?? {};
        w.open("w:rPrChange", this.changeAttrs(attrs)).open("w:rPr");
        writeRunProps(w, runFormatOf(Array.isArray(attrs.before) ? attrs.before : []));
        w.close("w:rPr").close("w:rPrChange");
        this.report.written.trackedChanges++;
      }
      w.close("w:rPr");
    }
    // Deleted text is `w:delText`; text moved away stays `w:t` (ECMA-376 §17.13.5.22).
    const deleted = revs.some((r) => r.kind === "del" && !r.moveId);
    if (piece.kind === "tab") w.empty("w:tab");
    else if (piece.kind === "br") w.empty("w:br");
    else if (piece.text) w.leaf(deleted ? "w:delText" : "w:t", { "xml:space": "preserve" }, piece.text);
    w.close("w:r");
  }

  // -- Images -----------------------------------------------------------------

  private image(node: DocxJSONNode): string | null {
    const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
    let relId: string;
    let natural: { width: number; height: number } | null = null;
    let linked = false;
    if (src.startsWith("data:")) {
      const decoded = decodeDataUrl(src);
      const ext = decoded ? DOCX_IMAGE_TYPES[decoded.mime] : undefined;
      if (!decoded || !ext) {
        this.drop("image", decoded?.mime ?? "data URL", "unsupported image type");
        return null;
      }
      const name = `image${this.media.length + 1}.${ext}`;
      this.media.push({ name, bytes: decoded.bytes });
      this.mediaTypes.add(ext);
      relId = this.rels.add(REL.image, `media/${name}`);
      natural = imagePixelSize(decoded.bytes);
    } else if (/^https?:\/\//i.test(src)) {
      if (this.options.remoteImages !== "link") {
        this.drop("image", src, "remote image skipped (use remoteImages: \"link\")");
        return null;
      }
      relId = this.rels.add(REL.image, src, true);
      linked = true;
    } else {
      this.drop("image", src || "image", "image source is neither a data URL nor http(s)");
      return null;
    }
    let width = pixelAttr(node.attrs?.width) ?? natural?.width ?? 400;
    let height = pixelAttr(node.attrs?.height) ?? (natural ? (natural.height * width) / natural.width : 300);
    if (width > MAX_IMAGE_WIDTH_PX) {
      height = (height * MAX_IMAGE_WIDTH_PX) / width;
      width = MAX_IMAGE_WIDTH_PX;
    }
    const cx = pxToEmu(width);
    const cy = pxToEmu(height);
    const id = ++this.docPrId;
    this.report.written.images++;
    const w = new XmlWriter(false);
    w.open("w:drawing").open("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 });
    w.empty("wp:extent", { cx, cy }).empty("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 });
    w.empty("wp:docPr", { id, name: `Picture ${id}`, descr: alt || undefined, title: title || undefined });
    w.open("wp:cNvGraphicFramePr").empty("a:graphicFrameLocks", { noChangeAspect: 1 }).close("wp:cNvGraphicFramePr");
    w.open("a:graphic").open("a:graphicData", { uri: "http://schemas.openxmlformats.org/drawingml/2006/picture" });
    w.open("pic:pic").open("pic:nvPicPr").empty("pic:cNvPr", { id: 0, name: `Picture ${id}`, descr: alt || undefined });
    w.empty("pic:cNvPicPr").close("pic:nvPicPr");
    w.open("pic:blipFill").empty("a:blip", linked ? { "r:link": relId } : { "r:embed": relId });
    w.open("a:stretch").empty("a:fillRect").close("a:stretch").close("pic:blipFill");
    w.open("pic:spPr").open("a:xfrm").empty("a:off", { x: 0, y: 0 }).empty("a:ext", { cx, cy }).close("a:xfrm");
    w.open("a:prstGeom", { prst: "rect" }).empty("a:avLst").close("a:prstGeom").close("pic:spPr");
    w.close("pic:pic").close("a:graphicData").close("a:graphic").close("wp:inline").close("w:drawing");
    return w.toString();
  }

  // -- Charts -----------------------------------------------------------------

  /** A `chart` node as a paragraph holding a native Word chart (`c:chart` in `wp:inline`). */
  private chartParagraph(w: XmlWriter, node: DocxJSONNode, ctx: BlockContext): void {
    const raw = node.attrs?.spec;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.drop("node", "chart", "chart has no spec");
      return;
    }
    const spec = normalizeChartSpec(raw).spec;
    const written = chartToOoxml(spec);
    for (const issue of written.issues) this.drop("node", "chart", issue);
    const name = `chart${this.charts.length + 1}.xml`;
    this.charts.push(written.xml);
    const relId = this.rels.add(CHART_OOXML_RELATIONSHIP, `charts/${name}`);
    // A chart without a width fills the line (the page's text width).
    let width = pixelAttr(node.attrs?.width) ?? MAX_IMAGE_WIDTH_PX;
    let height = pixelAttr(node.attrs?.height) ?? 320;
    if (width > MAX_IMAGE_WIDTH_PX) {
      height = (height * MAX_IMAGE_WIDTH_PX) / width;
      width = MAX_IMAGE_WIDTH_PX;
    }
    const cx = pxToEmu(width);
    const cy = pxToEmu(height);
    const id = ++this.docPrId;
    const title = spec.title || "";
    this.report.written.charts++;

    const drawing = new XmlWriter(false);
    drawing.open("w:r").open("w:drawing").open("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 });
    drawing.empty("wp:extent", { cx, cy }).empty("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 });
    drawing.empty("wp:docPr", { id, name: `Chart ${id}`, descr: title || undefined, title: title || undefined });
    drawing.empty("wp:cNvGraphicFramePr");
    drawing.open("a:graphic").open("a:graphicData", { uri: CHART_OOXML_NS });
    drawing.empty("c:chart", { "xmlns:c": CHART_OOXML_NS, "r:id": relId });
    drawing.close("a:graphicData").close("a:graphic").close("wp:inline").close("w:drawing").close("w:r");

    this.report.written.paragraphs++;
    w.open("w:p");
    const indent = ctx.quoteLevel * INDENT_STEP;
    const jc = alignment(node.attrs?.textAlign);
    if (indent || jc) {
      w.open("w:pPr");
      if (indent) w.empty("w:ind", { "w:left": indent });
      if (jc) w.val("w:jc", jc);
      w.close("w:pPr");
    }
    // The chart carries the comment marks of an atom node, if any.
    this.commentStarts(w, node.marks ?? []);
    w.raw(drawing.toString());
    this.commentEndsAfter(w, node);
    w.close("w:p");
  }

  // -- Tables -------------------------------------------------------------------

  private table(w: XmlWriter, node: DocxJSONNode, ctx: BlockContext): void {
    type Slot = { cell: DocxJSONNode; rowOffset: number; colOffset: number; colspan: number; rowspan: number } | null;
    const rows = (node.content ?? []).filter((row) => row.type === "tableRow" || row.content?.length);
    if (!rows.length) {
      this.drop("node", "table", "empty table");
      return;
    }
    const grid: Slot[][] = rows.map(() => []);
    rows.forEach((row, r) => {
      let col = 0;
      for (const cell of row.content ?? []) {
        while (grid[r][col]) col++;
        const colspan = Math.max(1, Math.min(63, Number(cell.attrs?.colspan) || 1));
        const rowspan = Math.max(1, Math.min(rows.length - r, Number(cell.attrs?.rowspan) || 1));
        for (let i = 0; i < rowspan; i++) {
          for (let j = 0; j < colspan; j++) {
            grid[r + i][col + j] = { cell, rowOffset: i, colOffset: j, colspan, rowspan };
          }
        }
        col += colspan;
      }
    });
    const cols = Math.max(1, Math.min(63, ...grid.map((row) => row.length)));
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      const slot = grid[0][c];
      const colwidth = slot?.cell.attrs?.colwidth;
      const px = Array.isArray(colwidth) ? Number(colwidth[slot!.colOffset]) : NaN;
      widths.push(Number.isFinite(px) && px > 0 ? pxToTwips(px) : 0);
    }
    const known = widths.reduce((n, v) => n + v, 0);
    const unknown = widths.filter((v) => !v).length;
    const fill = unknown ? Math.max(360, Math.floor(Math.max(0, CONTENT_WIDTH_TWIPS - known) / unknown)) : 0;
    for (let c = 0; c < cols; c++) if (!widths[c]) widths[c] = fill;

    this.report.written.tables++;
    w.open("w:tbl").open("w:tblPr");
    w.empty("w:tblW", { "w:w": 0, "w:type": "auto" });
    w.open("w:tblBorders");
    for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
      w.empty(`w:${side}`, { "w:val": "single", "w:sz": 4, "w:space": 0, "w:color": "auto" });
    }
    w.close("w:tblBorders");
    w.empty("w:tblLook", { "w:val": "04A0", "w:firstRow": 1, "w:lastRow": 0, "w:firstColumn": 1, "w:lastColumn": 0, "w:noHBand": 0, "w:noVBand": 1 });
    w.close("w:tblPr");
    w.open("w:tblGrid");
    widths.forEach((width) => w.empty("w:gridCol", { "w:w": width }));
    w.close("w:tblGrid");
    const cellCtx: BlockContext = { depth: ctx.depth + 1, quoteLevel: 0 };
    rows.forEach((row, r) => {
      w.open("w:tr");
      const cells = row.content ?? [];
      if (cells.length && cells.every((cell) => cell.type === "tableHeader")) {
        w.open("w:trPr").empty("w:tblHeader").close("w:trPr");
      }
      for (let c = 0; c < cols; c++) {
        const slot = grid[r][c];
        if (slot && slot.colOffset > 0) continue;
        const span = slot?.colspan ?? 1;
        const width = widths.slice(c, c + span).reduce((n, v) => n + v, 0);
        w.open("w:tc").open("w:tcPr").empty("w:tcW", { "w:w": width, "w:type": "dxa" });
        if (span > 1) w.val("w:gridSpan", span);
        if (slot && slot.rowspan > 1) {
          if (slot.rowOffset === 0) w.val("w:vMerge", "restart");
          else w.empty("w:vMerge");
        }
        w.close("w:tcPr");
        const content = slot && slot.rowOffset === 0 ? (slot.cell.content ?? []) : [];
        if (content.length) this.blocks(w, content, cellCtx);
        // A cell must end with a paragraph.
        const lastType = content[content.length - 1]?.type;
        if (!content.length || lastType === "table") w.empty("w:p");
        w.close("w:tc");
      }
      w.close("w:tr");
    });
    w.close("w:tbl");
  }

  // -- Other parts --------------------------------------------------------------

  numberingXml(): string | null {
    if (!this.nums.length) return null;
    const w = new XmlWriter();
    w.open("w:numbering", BODY_NS);
    const abstract = (id: number, kind: "bullet" | "decimal" | "task") => {
      w.open("w:abstractNum", { "w:abstractNumId": id }).val("w:multiLevelType", "hybridMultilevel");
      for (let level = 0; level < 9; level++) {
        w.open("w:lvl", { "w:ilvl": level }).val("w:start", 1);
        if (kind === "decimal") {
          const formats = ["decimal", "lowerLetter", "lowerRoman"];
          w.val("w:numFmt", formats[level % 3]).val("w:lvlText", `%${level + 1}.`);
        } else if (kind === "bullet") {
          w.val("w:numFmt", "bullet").val("w:lvlText", BULLETS[level % 3]);
        } else {
          w.val("w:numFmt", "none").val("w:lvlText", "");
        }
        w.val("w:lvlJc", "left");
        w.open("w:pPr").empty("w:ind", { "w:left": (level + 1) * INDENT_STEP, "w:hanging": kind === "task" ? 0 : 360 }).close("w:pPr");
        if (kind === "bullet") {
          const font = BULLET_FONTS[level % 3] === "Symbol" ? "Arial" : BULLET_FONTS[level % 3];
          w.open("w:rPr").empty("w:rFonts", { "w:ascii": font, "w:hAnsi": font, "w:hint": "default" }).close("w:rPr");
        }
        w.close("w:lvl");
      }
      w.close("w:abstractNum");
    };
    abstract(1, "bullet");
    abstract(2, "decimal");
    abstract(3, "task");
    for (const num of this.nums) {
      w.open("w:num", { "w:numId": num.numId }).val("w:abstractNumId", num.abstractId);
      if (num.start !== undefined) {
        w.open("w:lvlOverride", { "w:ilvl": num.level }).val("w:startOverride", num.start).close("w:lvlOverride");
      }
      w.close("w:num");
    }
    w.close("w:numbering");
    return w.toString();
  }

  stylesXml(): string {
    const w = new XmlWriter();
    w.open("w:styles", BODY_NS);
    const defaults = this.styles.defaults;
    const defaultRun = characterFormatToRun(defaults.character);
    w.open("w:docDefaults").open("w:rPrDefault").open("w:rPr");
    const font = defaultRun.font ?? "Calibri";
    w.empty("w:rFonts", { "w:ascii": font, "w:hAnsi": font, "w:eastAsia": font, "w:cs": font });
    const size = defaultRun.halfPoints ?? 22;
    w.val("w:sz", size).val("w:szCs", size);
    w.val("w:lang", "en-US");
    w.close("w:rPr").close("w:rPrDefault");
    w.open("w:pPrDefault").open("w:pPr");
    if (defaults.paragraph && Object.keys(defaults.paragraph).length) writeParagraphFormat(w, defaults.paragraph);
    else w.empty("w:spacing", { "w:after": 160, "w:line": 259, "w:lineRule": "auto" });
    w.close("w:pPr").close("w:pPrDefault").close("w:docDefaults");

    const byId = new Map(this.styles.styles.filter((s) => isValidStyleId(s.id)).map((s) => [s.id, s]));
    const written = new Set<string>();
    const blockOf = (style: StyleDefinition): StyleDefinition["block"] => {
      let current: StyleDefinition | undefined = style;
      for (let i = 0; current && i < 32; i++) {
        if (current.block) return current.block;
        current = current.basedOn ? byId.get(current.basedOn) : undefined;
      }
      return null;
    };
    const writeStyle = (style: StyleDefinition) => {
      if (written.has(style.id)) return;
      written.add(style.id);
      const isNormal = style.kind === "paragraph" && style.id === NORMAL_STYLE_ID;
      w.open("w:style", {
        "w:type": style.kind === "character" ? "character" : "paragraph",
        "w:default": isNormal ? 1 : undefined,
        "w:customStyle": style.builtin ? undefined : 1,
        "w:styleId": style.id,
      });
      w.val("w:name", fileStyleName(style.name || style.id));
      const base = style.basedOn && byId.has(style.basedOn) && byId.get(style.basedOn)!.kind === style.kind ? style.basedOn : undefined;
      if (base) w.val("w:basedOn", base);
      if (style.kind === "paragraph" && style.next && byId.get(style.next)?.kind === "paragraph") w.val("w:next", style.next);
      if (style.linked && byId.has(style.linked)) w.val("w:link", style.linked);
      if (style.priority !== undefined && Number.isFinite(style.priority)) w.val("w:uiPriority", Math.max(0, Math.round(style.priority)));
      if (style.hidden) w.empty("w:semiHidden").empty("w:unhideWhenUsed");
      if (style.quick) w.empty("w:qFormat");
      const block = style.kind === "paragraph" ? blockOf(style) : null;
      const ownBlock = style.kind === "paragraph" ? style.block : null;
      const outline = ownBlock?.type === "heading" ? Math.max(0, Math.min(8, (Number(ownBlock.attrs?.level) || 1) - 1)) : undefined;
      if (style.kind === "paragraph" && (style.paragraph || outline !== undefined)) {
        const p = new XmlWriter(false);
        writeParagraphFormat(p, style.paragraph, outline);
        const xml = p.toString();
        if (xml) w.open("w:pPr").raw(xml).close("w:pPr");
      }
      const run = characterFormatToRun(style.character);
      if (block?.type === "codeBlock" && !run.font) run.font = "Consolas";
      if (hasRunProps(run)) {
        w.open("w:rPr");
        writeRunProps(w, run);
        w.close("w:rPr");
      }
      w.close("w:style");
    };
    // Base styles first, so Word never sees a `basedOn` before its target.
    const visit = (style: StyleDefinition, depth = 0) => {
      if (depth > 32 || written.has(style.id)) return;
      const base = style.basedOn ? byId.get(style.basedOn) : undefined;
      if (base) visit(base, depth + 1);
      writeStyle(style);
    };
    byId.forEach((style) => visit(style));
    for (const id of this.extraStyles) {
      if (written.has(id)) continue;
      const extra = EXTRA_STYLES[id] ?? { id, name: id, kind: "paragraph" as const, basedOn: NORMAL_STYLE_ID };
      byId.set(id, extra);
      writeStyle(extra);
    }
    w.close("w:styles");
    return w.toString();
  }

  settingsXml(): string {
    const w = new XmlWriter();
    w.open("w:settings", BODY_NS).empty("w:zoom", { "w:percent": 100 });
    if (this.anonymous) w.empty("w:removePersonalInformation");
    w.val("w:defaultTabStop", 720);
    w.val("w:characterSpacingControl", "doNotCompress");
    w.open("w:compat").empty("w:compatSetting", {
      "w:name": "compatibilityMode",
      "w:uri": "http://schemas.microsoft.com/office/word",
      "w:val": 15,
    });
    w.close("w:compat").close("w:settings");
    return w.toString();
  }

  commentParts(): { comments: string; extended: string } | null {
    if (!this.comments.size) return null;
    const w = new XmlWriter();
    const ext = new XmlWriter();
    w.open("w:comments", BODY_NS);
    ext.open("w15:commentsEx", { "xmlns:w15": NS.w15, "xmlns:mc": NS.mc, "mc:Ignorable": "w15" });
    for (const entry of this.comments.values()) {
      if (!entry.started) continue;
      const { thread } = entry;
      const parentPara = this.comment(w, entry.ids[0], thread.author, thread.createdAt, thread.body);
      ext.empty("w15:commentEx", { "w15:paraId": parentPara, "w15:done": thread.resolved ? 1 : 0 });
      this.report.written.comments++;
      thread.replies.forEach((reply, i) => {
        const para = this.comment(w, entry.ids[i + 1], reply.author, reply.createdAt, reply.body);
        ext.empty("w15:commentEx", { "w15:paraId": para, "w15:paraIdParent": parentPara, "w15:done": thread.resolved ? 1 : 0 });
        this.report.written.replies++;
      });
    }
    w.close("w:comments");
    ext.close("w15:commentsEx");
    return { comments: w.toString(), extended: ext.toString() };
  }

  private comment(w: XmlWriter, id: number, author: ReviewAuthor | undefined, createdAt: number, body: string): string {
    const name = this.authorName(author?.name, author?.id);
    w.open("w:comment", {
      "w:id": id,
      "w:author": name,
      "w:date": isoDate(createdAt),
      "w:initials": this.anonymous ? ANONYMOUS_INITIALS : initialsOf(name),
    });
    const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
    let paraId = "";
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      if (last) paraId = (this.paraIdCounter++).toString(16).toUpperCase().padStart(8, "0");
      w.open("w:p", last ? { "w14:paraId": paraId, "w14:textId": "77777777" } : undefined);
      w.open("w:pPr").val("w:pStyle", "CommentText").close("w:pPr");
      if (i === 0) {
        w.open("w:r").open("w:rPr").val("w:rStyle", "CommentReference").close("w:rPr").empty("w:annotationRef").close("w:r");
      }
      if (line) w.open("w:r").leaf("w:t", { "xml:space": "preserve" }, line).close("w:r");
      w.close("w:p");
    });
    w.close("w:comment");
    return paraId;
  }

  peopleXml(): string | null {
    if (this.anonymous || !this.people.size) return null;
    const w = new XmlWriter();
    w.open("w15:people", { "xmlns:w15": NS.w15, "xmlns:mc": NS.mc, "mc:Ignorable": "w15" });
    for (const [name, id] of this.people) {
      w.open("w15:person", { "w15:author": name });
      w.empty("w15:presenceInfo", { "w15:providerId": "None", "w15:userId": id });
      w.close("w15:person");
    }
    w.close("w15:people");
    return w.toString();
  }

  coreXml(now: Date): string {
    const w = new XmlWriter();
    w.open("cp:coreProperties", {
      "xmlns:cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
      "xmlns:dc": "http://purl.org/dc/elements/1.1/",
      "xmlns:dcterms": "http://purl.org/dc/terms/",
      "xmlns:dcmitype": "http://purl.org/dc/dcmitype/",
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    });
    if (this.options.title) w.leaf("dc:title", undefined, this.options.title);
    const creator = this.anonymous ? undefined : this.defaultAuthor?.name;
    if (creator) w.leaf("dc:creator", undefined, creator).leaf("cp:lastModifiedBy", undefined, creator);
    const date = isoDate(now.getTime()) ?? "2026-01-01T00:00:00Z";
    w.leaf("dcterms:created", { "xsi:type": "dcterms:W3CDTF" }, date);
    w.leaf("dcterms:modified", { "xsi:type": "dcterms:W3CDTF" }, date);
    w.close("cp:coreProperties");
    return w.toString();
  }

  /** Assembles every part; `[Content_Types].xml` first. */
  parts(now: Date): DocxPackagePart[] {
    const document = this.documentXml();
    const parts: DocxPackagePart[] = [];
    const overrides: [string, string][] = [];
    const add = (name: string, data: string, contentType: string) => {
      parts.push({ name, data });
      overrides.push([`/${name}`, contentType]);
    };
    this.rels.add(REL.styles, "styles.xml");
    this.rels.add(REL.settings, "settings.xml");
    const numbering = this.numberingXml();
    if (numbering) this.rels.add(REL.numbering, "numbering.xml");
    const comments = this.commentParts();
    if (comments) {
      this.rels.add(REL.comments, "comments.xml");
      this.rels.add(REL.commentsExtended, "commentsExtended.xml");
    }
    const people = this.peopleXml();
    if (people) this.rels.add(REL.people, "people.xml");
    // Styles last: the document and comments decide which extra styles are needed.
    const styles = this.stylesXml();

    add("word/document.xml", document, `${CT_WML}document.main+xml`);
    add("word/styles.xml", styles, `${CT_WML}styles+xml`);
    add("word/settings.xml", this.settingsXml(), `${CT_WML}settings+xml`);
    if (numbering) add("word/numbering.xml", numbering, `${CT_WML}numbering+xml`);
    if (comments) {
      add("word/comments.xml", comments.comments, `${CT_WML}comments+xml`);
      add("word/commentsExtended.xml", comments.extended, `${CT_WML}commentsExtended+xml`);
    }
    if (people) add("word/people.xml", people, `${CT_WML}people+xml`);
    parts.push({ name: "word/_rels/document.xml.rels", data: this.rels.xml() });
    for (const file of this.media) parts.push({ name: `word/media/${file.name}`, data: file.bytes });
    this.charts.forEach((xml, i) => add(`word/charts/chart${i + 1}.xml`, xml, CHART_OOXML_CONTENT_TYPE));
    add("docProps/core.xml", this.coreXml(now), "application/vnd.openxmlformats-package.core-properties+xml");
    const app = new XmlWriter();
    app.open("Properties", { xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" });
    app.leaf("Application", undefined, "@pixerate/editor").close("Properties");
    add("docProps/app.xml", app.toString(), "application/vnd.openxmlformats-officedocument.extended-properties+xml");

    const root = new Relationships();
    root.add(REL.officeDocument, "word/document.xml");
    root.add(REL.core, "docProps/core.xml");
    root.add(REL.app, "docProps/app.xml");

    const types = new XmlWriter();
    types.open("Types", { xmlns: "http://schemas.openxmlformats.org/package/2006/content-types" });
    types.empty("Default", { Extension: "rels", ContentType: "application/vnd.openxmlformats-package.relationships+xml" });
    types.empty("Default", { Extension: "xml", ContentType: "application/xml" });
    for (const ext of this.mediaTypes) types.empty("Default", { Extension: ext, ContentType: DOCX_IMAGE_CONTENT_TYPES[ext] });
    for (const [name, contentType] of overrides) types.empty("Override", { PartName: name, ContentType: contentType });
    types.close("Types");
    return [
      { name: "[Content_Types].xml", data: types.toString() },
      { name: "_rels/.rels", data: root.xml() },
      ...parts,
    ];
  }
}

const SPARK_BARS = "▁▂▃▄▅▆▇█";

/** A sparkline as text: its label, else one block character per value (▁ lowest, █ highest). */
function sparklineText(attrs: Record<string, any> | undefined): string {
  if (typeof attrs?.label === "string" && attrs.label.trim()) return attrs.label;
  const values: number[] = (Array.isArray(attrs?.values) ? attrs.values : []).filter(
    (v: unknown): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (!values.length) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  return values.map((v) => SPARK_BARS[span ? Math.round(((v - min) / span) * (SPARK_BARS.length - 1)) : 3]).join("");
}

const isInlineType = (type: string | undefined) =>
  type === "hardBreak" || type === "image" || type === "mention" || type === "sparkline" || type === "text";

/** Styles written when the document uses them but the registry has no definition. */
const EXTRA_STYLES: Record<string, StyleDefinition> = {
  BlockText: {
    id: "BlockText",
    name: "Block Text",
    kind: "paragraph",
    basedOn: NORMAL_STYLE_ID,
    paragraph: { indentLeft: "0.5in", indentRight: "0.5in" },
    character: { italic: true },
    priority: 99,
    builtin: true,
  },
  ListParagraph: {
    id: "ListParagraph",
    name: "List Paragraph",
    kind: "paragraph",
    basedOn: NORMAL_STYLE_ID,
    paragraph: { indentLeft: "0.5in" },
    priority: 34,
    quick: true,
    builtin: true,
  },
  Code: {
    id: "Code",
    name: "Code",
    kind: "paragraph",
    basedOn: NORMAL_STYLE_ID,
    block: { type: "codeBlock" },
    character: { fontFamily: "Consolas", fontSize: "10pt" },
    paragraph: { spaceAfter: "0pt", lineHeight: "1" },
    priority: 30,
  },
  Hyperlink: {
    id: "Hyperlink",
    name: "Hyperlink",
    kind: "character",
    character: { color: "#0563C1", underline: true },
    priority: 99,
    hidden: true,
    builtin: true,
  },
  CommentReference: {
    id: "CommentReference",
    name: "annotation reference",
    kind: "character",
    character: { fontSize: "8pt" },
    priority: 99,
    hidden: true,
    builtin: true,
  },
  CommentText: {
    id: "CommentText",
    name: "annotation text",
    kind: "paragraph",
    basedOn: NORMAL_STYLE_ID,
    character: { fontSize: "10pt" },
    priority: 99,
    hidden: true,
    builtin: true,
  },
};
for (let level = 1; level <= 6; level++) {
  EXTRA_STYLES[`Heading${level}`] = {
    id: `Heading${level}`,
    name: `Heading ${level}`,
    kind: "paragraph",
    basedOn: NORMAL_STYLE_ID,
    next: NORMAL_STYLE_ID,
    block: { type: "heading", attrs: { level } },
    character: { bold: true },
    priority: 9,
    quick: true,
    builtin: true,
  };
}

function resolveInput(
  input: DocxExportEditorLike | DocxJSONNode,
  options: DocxExportOptions,
): { doc: DocxJSONNode; options: DocxExportOptions } {
  if (!isEditorLike(input)) return { doc: input, options };
  const storage = (input.storage ?? {}) as any;
  return {
    doc: input.getJSON(),
    options: {
      ...options,
      comments: options.comments !== undefined ? options.comments : (storage.comment?.store ?? null),
      styles: options.styles ?? storage.paragraphStyles?.registry ?? undefined,
    },
  };
}

/**
 * Builds the package parts of a DOCX file without zipping them (synchronous;
 * useful for inspection and tests). See {@link exportDocx}.
 */
export function createDocxParts(
  input: DocxExportEditorLike | DocxJSONNode,
  options: DocxExportOptions = {},
): { parts: DocxPackagePart[]; report: DocxExportReport } {
  const resolved = resolveInput(input, options);
  const builder = new DocxBuilder(
    resolved.doc ?? { type: "doc", content: [] },
    resolved.options,
    threadsOf(resolved.options.comments),
    stylesOf(resolved.options.styles),
  );
  const parts = builder.parts(resolved.options.now?.() ?? new Date());
  return { parts, report: builder.report };
}

/**
 * Exports an editor (or its JSON) as a Word document. Resolves with the file
 * bytes and a report of what was dropped. Never fetches anything: remote
 * images are skipped (or linked with `remoteImages: "link"`).
 */
export async function exportDocx(
  input: DocxExportEditorLike | DocxJSONNode,
  options: DocxExportOptions = {},
): Promise<DocxExportResult> {
  const { parts, report } = createDocxParts(input, options);
  const data = await writeZip(parts as ZipWriteEntry[], { compression: options.compression });
  return { data, report };
}

/** Like {@link exportDocx}, but resolves with a `Blob` of type {@link DOCX_EXPORT_MIME_TYPE}. */
export async function exportDocxBlob(
  input: DocxExportEditorLike | DocxJSONNode,
  options: DocxExportOptions = {},
): Promise<{ blob: Blob; report: DocxExportReport }> {
  const { data, report } = await exportDocx(input, options);
  return { blob: new Blob([data as BlobPart], { type: DOCX_EXPORT_MIME_TYPE }), report };
}
