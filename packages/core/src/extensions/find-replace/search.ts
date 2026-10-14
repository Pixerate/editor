// Portions ported from wordcraft/crates/engine/src/cmd/edit.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { Mark as ProsemirrorMark, Node as ProsemirrorNode, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  FIND_PARAGRAPH_MARK,
  compileFindPattern,
  createSearchBudget,
  expandReplacement,
  findAllMatches,
  parseReplacement,
  type FindOptions,
  type FindPatternError,
} from "./pattern";

/** Name of the tracked-deletion mark (see `track-changes.ts`); deleted text is not searched. */
const DELETION_MARK = "deletion";
/** Review marks the replacement text does not inherit from the found text. */
const DROPPED_REPLACEMENT_MARKS = new Set([DELETION_MARK, "formatChange"]);
/** Stands for an inline node other than text or a hard break (`^g`). */
const OBJECT_CHAR = "\ufffc";

export interface FindMatch {
  /** Document position of the first matched character. */
  from: number;
  /** Document position after the last matched character. */
  to: number;
  /** The matched text (`\r` for paragraph marks, `\n` for hard breaks). */
  text: string;
  /** The Replace with text for this match (`\r` splits paragraphs). */
  replacement: string;
}

export interface DocumentSearchOptions {
  /** Replace with text (`^&`, `^c`, `\1`…). */
  replacement?: string;
  /** Text of `^c` in the replacement. */
  clipboardText?: string;
  /** Wall-clock budget for the whole search (default 250 ms). */
  timeLimitMs?: number;
  /** Match cap (default 10 000). */
  maxMatches?: number;
}

export interface DocumentSearchResult {
  matches: FindMatch[];
  /** The search stopped early at the match cap or time budget. */
  truncated: boolean;
  error: FindPatternError | null;
}

interface Block {
  node: ProsemirrorNode;
  pos: number;
  parent: ProsemirrorNode | null;
  index: number;
}

/**
 * Finds `query` in a document. Each textblock is read as text without
 * tracked-deleted runs (a deletion "cuts" the text, so no match spans it, but
 * word boundaries see the live text on both sides); a pattern that can match
 * `^p` reads runs of sibling textblocks as one text with `\r` between them.
 */
export function searchDocument(
  doc: ProsemirrorNode,
  query: string,
  options: FindOptions = {},
  searchOptions: DocumentSearchOptions = {},
): DocumentSearchResult {
  if (!query) return { matches: [], truncated: false, error: null };
  const compiled = compileFindPattern(query, options);
  if (!compiled.ok) return { matches: [], truncated: false, error: compiled.error };
  const pattern = compiled.pattern;
  const pieces = parseReplacement(searchOptions.replacement ?? "", options);
  const budget = createSearchBudget({ timeLimitMs: searchOptions.timeLimitMs });
  const maxMatches = searchOptions.maxMatches ?? 10_000;

  const blocks: Block[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (!node.isTextblock) return true;
    blocks.push({ node, pos, parent, index });
    return false;
  });

  // Textblocks read as one text: consecutive siblings when the pattern spans paragraphs.
  const chunks: Block[][] = [];
  blocks.forEach((block, i) => {
    const prev = blocks[i - 1];
    const joins =
      pattern.spansParagraphs && prev && prev.parent === block.parent && prev.index + 1 === block.index;
    if (joins) chunks[chunks.length - 1].push(block);
    else chunks.push([block]);
  });

  const matches: FindMatch[] = [];
  let truncated = false;
  for (const chunk of chunks) {
    let hay = "";
    // Document position of each hay offset, and the position after it.
    const posOf: number[] = [];
    const endOf: number[] = [];
    const cuts: number[] = [];
    chunk.forEach((block, k) => {
      const contentStart = block.pos + 1;
      block.node.forEach((child, offset) => {
        const at = contentStart + offset;
        if (child.marks.some((m) => m.type.name === DELETION_MARK)) {
          if (cuts[cuts.length - 1] !== hay.length) cuts.push(hay.length);
          return;
        }
        if (child.isText) {
          const text = child.text ?? "";
          for (let j = 0; j < text.length; j++) {
            posOf.push(at + j);
            endOf.push(at + j + 1);
          }
          hay += text;
        } else {
          posOf.push(at);
          endOf.push(at + child.nodeSize);
          hay += child.type.name === "hardBreak" ? "\n" : OBJECT_CHAR;
        }
      });
      const next = chunk[k + 1];
      if (next) {
        posOf.push(contentStart + block.node.content.size);
        endOf.push(next.pos + 1);
        hay += FIND_PARAGRAPH_MARK;
      }
    });
    if (!hay) continue;
    const result = findAllMatches(pattern, hay, {
      cuts,
      budget,
      maxMatches: maxMatches - matches.length,
    });
    for (const m of result.matches) {
      matches.push({
        from: posOf[m.start],
        to: endOf[m.end - 1],
        text: m.groups[0] ?? hay.slice(m.start, m.end),
        replacement: expandReplacement(pieces, m, searchOptions.clipboardText ?? ""),
      });
    }
    if (result.truncated) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated, error: null };
}

/** Marks the replacement for a match inherits: the found text's, minus tracked-change marks. */
function replacementMarks(doc: ProsemirrorNode, from: number, to: number): readonly ProsemirrorMark[] {
  const $from = doc.resolve(from);
  const node = from < to ? $from.nodeAfter : null;
  const marks = node ? node.marks : $from.marks();
  return marks.filter((m) => !DROPPED_REPLACEMENT_MARKS.has(m.type.name));
}

/** Inline content for a piece of replacement text: `\n` becomes a hard break when the schema has one. */
function inlineContent(schema: Schema, text: string, marks: readonly ProsemirrorMark[]): ProsemirrorNode[] {
  const nodes: ProsemirrorNode[] = [];
  const hardBreak = schema.nodes.hardBreak;
  const parts = hardBreak ? text.split("\n") : [text];
  parts.forEach((part, i) => {
    if (i > 0) nodes.push(hardBreak.create(null, null, marks));
    if (part) nodes.push(schema.text(part, marks));
  });
  return nodes;
}

/**
 * Replaces matches in one transaction, last first so earlier positions stay
 * valid. A paragraph mark (`\r` or U+2029) in a replacement splits the
 * paragraph. Returns the mapped end of each replacement (in match order).
 */
export function applyReplacements(tr: Transaction, matches: readonly FindMatch[]): number[] {
  const ends: number[] = new Array(matches.length);
  const schema = tr.doc.type.schema;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { from, to, replacement } = matches[i];
    const marks = replacementMarks(tr.doc, from, to);
    const parts = replacement.split(/[\r\u2029]/);
    const stepsBefore = tr.steps.length;
    const first = inlineContent(schema, parts[0], marks);
    if (first.length) tr.replaceWith(from, to, first);
    else if (to > from) tr.delete(from, to);
    let pos = tr.mapping.slice(stepsBefore).map(to, 1);
    for (let k = 1; k < parts.length; k++) {
      tr.split(pos);
      pos += 2;
      const content = inlineContent(schema, parts[k], marks);
      if (content.length) {
        tr.insert(pos, content);
        pos += content.reduce((size, node) => size + node.nodeSize, 0);
      }
    }
    // Positions of later replacements were already mapped; record this one's end
    // and shift the later ends by what this replacement changed.
    const map = tr.mapping.slice(stepsBefore);
    for (let j = i + 1; j < matches.length; j++) ends[j] = map.map(ends[j], 1);
    ends[i] = pos;
  }
  return ends;
}
