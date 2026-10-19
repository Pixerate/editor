import { splitSource } from "../source/lines.js";
import type { DiagramDataError } from "../sankey/index.js";

/**
 * Reading Mermaid `treemap-beta` / `treemap` diagrams into data, for hosts
 * that draw them with their own components (`familyViews`). Treemaps stay
 * render-only: the text is kept verbatim and not edited through `EditOp`s.
 *
 * The grammar follows Mermaid's: one item per line, nested by indentation.
 * A section is a quoted name (`"Sales"` or `'Sales'`); a leaf adds a value
 * after `:` or `,` (`"Q1": 1,200`, commas in the number are dropped). Either
 * may end with a `:::class`. `title`, `accTitle` and `accDescr` lines are
 * read; `classDef` lines and `%%` comments are skipped. Styling is not
 * returned.
 *
 * @module
 */

export interface TreemapItem {
  name: string;
  /** Leaves only. */
  value?: number;
  /** Sections only (possibly empty). */
  children?: TreemapItem[];
  /** The `:::class` the item names, if any. */
  className?: string;
}

export interface TreemapData {
  /** `title` line in the body (frontmatter titles stay on `doc.graph.title`). */
  title?: string;
  accTitle?: string;
  accDescr?: string;
  /** Top-level items; Mermaid allows several. */
  items: TreemapItem[];
}

export type TreemapParse = { data: TreemapData } | DiagramDataError;

const NAME = String.raw`(?:"([^"]*)"|'([^']*)')`;
const CLASS = String.raw`(?:\s*:::\s*([A-Za-z_]\w*))?`;
const SECTION_RE = new RegExp(String.raw`^${NAME}${CLASS}$`);
const LEAF_RE = new RegExp(String.raw`^${NAME}\s*[:,]\s*([0-9_.,]+)${CLASS}$`);

/**
 * Reads a treemap's items. `source` is the whole Mermaid text (with
 * frontmatter and header), e.g. a passthrough document's `doc.source`.
 * Returns an error for a line Mermaid would reject (an unquoted name, a
 * missing or negative value) or when there are no items.
 */
export function parseTreemap(source: string): TreemapParse {
  const split = splitSource(source);
  if (!/^\s*treemap(?:-beta)?\b/i.test(split.header)) {
    return { error: "Not a treemap: the first line should be `treemap-beta`." };
  }
  const data: TreemapData = { items: [] };
  const stack: { item: TreemapItem; indent: number }[] = [];
  const firstLine = split.headerIndex + 2;
  const lines = split.bodyLines;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = firstLine + i;
    const indent = /^[ \t]*/.exec(raw)![0].length;
    const text = stripComment(raw).trim();
    if (!text) continue;

    const accBlock = /^accDescr\s*\{(.*)$/.exec(text);
    if (accBlock) {
      // `accDescr { … }` may run over several lines.
      let body = accBlock[1]!;
      while (!body.includes("}") && i + 1 < lines.length) body += `\n${lines[++i]}`;
      if (!body.includes("}")) return { error: "`accDescr {` is never closed.", line };
      data.accDescr = body.slice(0, body.indexOf("}")).trim();
      continue;
    }
    const acc = /^(accTitle|accDescr)\s*:(.*)$/.exec(text);
    if (acc) {
      data[acc[1] as "accTitle" | "accDescr"] = acc[2]!.trim();
      continue;
    }
    const title = /^title(?:[ \t]+(.*))?$/.exec(text);
    if (title) {
      data.title = (title[1] ?? "").trim() || undefined;
      continue;
    }
    if (/^classDef\s/.test(text)) continue;

    let item: TreemapItem;
    const leaf = LEAF_RE.exec(text);
    const section = leaf ? null : SECTION_RE.exec(text);
    if (leaf) {
      const value = Number.parseFloat(leaf[3]!.replace(/,/g, ""));
      if (!Number.isFinite(value)) return { error: `"${leaf[3]}" is not a number.`, line };
      item = { name: leaf[1] ?? leaf[2]!, value };
      if (leaf[4]) item.className = leaf[4];
    } else if (section) {
      item = { name: section[1] ?? section[2]!, children: [] };
      if (section[3]) item.className = section[3];
    } else {
      return {
        error: /^["']/.test(text)
          ? 'Expected `"Name"` for a section or `"Name": value` for a leaf.'
          : 'Names must be in quotes, e.g. `"Sales": 120`.',
        line,
      };
    }

    // As Mermaid does: the parent is the nearest section above with less indent.
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.item;
    if (parent) parent.children!.push(item);
    else data.items.push(item);
    if (item.children) stack.push({ item, indent });
  }

  if (!data.items.length) return { error: 'No items: add lines like `"Sales": 120`.' };
  return { data };
}

/** Drops a `%%` comment, unless it sits inside a quoted name. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "%" && line[i + 1] === "%") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** A treemap item's value: a leaf's own, or the sum of a section's leaves. */
export function treemapValue(item: TreemapItem): number {
  if (!item.children) return item.value ?? 0;
  return item.children.reduce((sum, child) => sum + treemapValue(child), 0);
}
