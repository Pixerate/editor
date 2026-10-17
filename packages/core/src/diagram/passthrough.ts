import type {
  AdapterParseContext,
  DiagramAdapter,
  DiagramFamily,
  EditOp,
  MermaidDocument,
  SupportTier,
} from "./types.js";
import { assembleDocument } from "./flowchart/serialize.js";
import { setFrontmatterTitle } from "./lines-grammar/engine.js";

/** Body of a render-only document: the raw body lines. */
export interface PassthroughBody {
  lines: string[];
}

/**
 * Adapter for families the diagram module cannot edit on a canvas. The text is preserved
 * verbatim; only `replaceSource`, `setTitle` and metadata edits apply.
 */
export function createPassthroughAdapter(
  family: DiagramFamily,
  tier: SupportTier = "render-only",
): DiagramAdapter<PassthroughBody> {
  const adapter: DiagramAdapter<PassthroughBody> = {
    family,
    tier,
    parse(source: string, ctx: AdapterParseContext): MermaidDocument<PassthroughBody> {
      const title =
        typeof ctx.preamble.frontmatter?.title === "string"
          ? ctx.preamble.frontmatter.title
          : undefined;
      return {
        family,
        tier,
        source,
        preamble: ctx.preamble,
        header: ctx.header,
        trailing: ctx.trailing,
        eol: ctx.eol,
        graph: { direction: "TB", nodes: [], edges: [], groups: [], classDefs: {}, title },
        meta: ctx.meta,
        metaCarrier: ctx.metaCarrier,
        body: { lines: ctx.bodyLines },
        diagnostics: [],
        dirty: false,
      };
    },
    serialize(doc) {
      return assembleDocument(doc, doc.body.lines, "  ");
    },
    apply(doc, op: EditOp) {
      const next: MermaidDocument<PassthroughBody> = { ...doc, meta: { ...doc.meta } };
      switch (op.type) {
        case "setViewport":
          next.meta.viewport = op.viewport;
          break;
        case "setMetaExt":
          next.meta.ext = { ...(next.meta.ext ?? {}), [op.key]: op.value };
          break;
        case "moveNodes":
          next.meta.layout = { ...(next.meta.layout ?? {}) };
          for (const { id, position } of op.moves) next.meta.layout[id] = position;
          break;
        case "setTitle":
          next.preamble = {
            ...next.preamble,
            lines: setFrontmatterTitle(next.preamble.lines, op.title),
          };
          next.dirty = true;
          break;
        default:
          return doc;
      }
      next.source = adapter.serialize(next);
      return next;
    },
  };
  return adapter;
}
