import type { DiagramFamily, EditOp, MermaidDocument, MetaCarrier } from "./types.js";
import { detectFamilyFromHeader, splitSource } from "./source/lines.js";
import {
  defaultCarrierFor,
  emptyMeta,
  extractMetaFromBody,
  extractMetaFromFrontmatter,
  mergeMeta,
} from "./source/metadata.js";
import { getDiagramAdapter } from "./registry.js";

export interface ParseOptions {
  /** Force where metadata is written. Defaults per family. */
  metaCarrier?: MetaCarrier;
}

/** Detects the diagram family of a Mermaid source without fully parsing it. */
export function detectFamily(source: string): DiagramFamily {
  return detectFamilyFromHeader(splitSource(source).header);
}

/**
 * Parses Mermaid text into a {@link MermaidDocument}.
 *
 * Never throws: unknown or malformed input yields a `render-only` document
 * with diagnostics, so hosts can always show the source editor.
 */
export function parseMermaid(source: string, options: ParseOptions = {}): MermaidDocument {
  const split = splitSource(source);
  const family = detectFamilyFromHeader(split.header);
  const fromBody = extractMetaFromBody(split.bodyLines);
  const fromFm = extractMetaFromFrontmatter(split.preamble);
  let meta = emptyMeta();
  if (fromFm) meta = mergeMeta(meta, fromFm);
  if (fromBody.meta) meta = mergeMeta(meta, fromBody.meta);
  const metaCarrier: MetaCarrier =
    options.metaCarrier ?? (fromFm && !fromBody.meta ? "frontmatter" : defaultCarrierFor(family));
  const adapter = getDiagramAdapter(family);
  const doc = adapter.parse(source, {
    source,
    eol: split.eol,
    preamble: split.preamble,
    header: split.header,
    bodyLines: fromBody.bodyLines,
    trailing: split.trailing,
    meta,
    metaCarrier,
    family,
  });
  return doc;
}

/** Serialises a document back to Mermaid text. */
export function serializeMermaid(doc: MermaidDocument): string {
  return getDiagramAdapter(doc.family).serialize(doc);
}

/**
 * Applies an edit and returns a new document whose `source` is the updated
 * text. Documents are immutable; keep the returned value.
 */
export function applyEdit(doc: MermaidDocument, op: EditOp): MermaidDocument {
  if (op.type === "replaceSource") {
    const next = parseMermaid(op.source, { metaCarrier: doc.metaCarrier });
    next.dirty = true;
    return next;
  }
  const next = getDiagramAdapter(doc.family).apply(doc, op);
  if (next !== doc && next.source === doc.source) {
    // Adapters normally refresh `source`; make sure it is current.
    next.source = serializeMermaid(next);
  }
  return next;
}

/** Applies several edits in order. */
export function applyEdits(doc: MermaidDocument, ops: EditOp[]): MermaidDocument {
  return ops.reduce((d, op) => applyEdit(d, op), doc);
}
