import type { MetaCarrier, Point, Preamble, DiagramMeta } from "../types.js";

/** Prefix of the metadata comment line. */
export const META_COMMENT_PREFIX = "%% @pixerate ";
/** Frontmatter key used when comments are not safe for a family. */
export const META_FRONTMATTER_KEY = "pixerate";
/** Frontmatter key written by Ursula, still read. */
const LEGACY_FRONTMATTER_KEY = "ursula";

/** `%% @pixerate {json}`; Ursula's `%% @ursula {json}` is read the same way and rewritten as `@pixerate`. */
const META_LINE = /^\s*%%\s*@(?:pixerate|ursula)\s+(\{.*\})\s*$/;
/**
 * `%% @layout {"id":[x,y]}`, the positions-only comment written by the
 * redesign-agentic-web diagram editor. Same coordinates as `meta.layout`
 * (absolute top-left), so it is read as layout and replaced by `@pixerate` the
 * next time the document is serialised.
 */
const LEGACY_LAYOUT_LINE = /^\s*%%\s*@layout\b\s*(.*?)\s*$/;

export function emptyMeta(): DiagramMeta {
  return { v: 1 };
}

export function isMetaLine(line: string): boolean {
  return META_LINE.test(line) || LEGACY_LAYOUT_LINE.test(line);
}

/**
 * Extracts `%% @pixerate {json}` lines from a body. Several lines are merged
 * (later wins) so that hand-edited documents stay tolerant.
 */
export function extractMetaFromBody(bodyLines: string[]): {
  bodyLines: string[];
  meta: DiagramMeta | null;
} {
  let meta: DiagramMeta | null = null;
  let legacy: DiagramMeta | null = null;
  const rest: string[] = [];
  for (const line of bodyLines) {
    const m = META_LINE.exec(line);
    if (m) {
      const parsed = safeParseMeta(m[1]!);
      if (parsed) meta = mergeMeta(meta ?? emptyMeta(), parsed);
      continue;
    }
    const lm = LEGACY_LAYOUT_LINE.exec(line);
    if (lm) {
      // A malformed payload is dropped too: keeping it would leave a second,
      // stale layout comment beside the `@pixerate` one.
      const parsed = safeParseMeta(`{"layout":${lm[1] || "null"}}`);
      if (parsed) legacy = mergeMeta(legacy ?? emptyMeta(), parsed);
      continue;
    }
    rest.push(line);
  }
  // `@pixerate` wins wherever both carry a position.
  if (legacy) meta = meta ? mergeMeta(legacy, meta) : legacy;
  return { bodyLines: rest, meta };
}

export function extractMetaFromFrontmatter(preamble: Preamble): DiagramMeta | null {
  const value = preamble.frontmatter?.[META_FRONTMATTER_KEY] ?? preamble.frontmatter?.[LEGACY_FRONTMATTER_KEY];
  if (!value) return null;
  if (typeof value === "string") return safeParseMeta(value);
  if (typeof value === "object") return normaliseMeta(value as Record<string, unknown>);
  return null;
}

function safeParseMeta(json: string): DiagramMeta | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return normaliseMeta(value);
  } catch {
    return null;
  }
}

function normaliseMeta(value: Record<string, unknown>): DiagramMeta {
  const meta: DiagramMeta = { v: 1 };
  if (value.layout && typeof value.layout === "object") {
    const layout: Record<string, Point> = {};
    for (const [id, pos] of Object.entries(value.layout as Record<string, unknown>)) {
      if (Array.isArray(pos) && pos.length === 2 && pos.every((n) => typeof n === "number")) {
        layout[id] = [pos[0] as number, pos[1] as number];
      }
    }
    meta.layout = layout;
  }
  if (value.sizes && typeof value.sizes === "object") {
    const sizes: Record<string, readonly [number, number]> = {};
    for (const [id, size] of Object.entries(value.sizes as Record<string, unknown>)) {
      if (Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === "number")) {
        sizes[id] = [size[0] as number, size[1] as number];
      }
    }
    meta.sizes = sizes;
  }
  if (value.viewport && typeof value.viewport === "object") {
    const vp = value.viewport as Record<string, unknown>;
    if (typeof vp.x === "number" && typeof vp.y === "number" && typeof vp.zoom === "number") {
      meta.viewport = { x: vp.x, y: vp.y, zoom: vp.zoom };
    }
  }
  if (value.ext && typeof value.ext === "object") meta.ext = value.ext as Record<string, unknown>;
  return meta;
}

export function mergeMeta(a: DiagramMeta, b: DiagramMeta): DiagramMeta {
  return {
    v: 1,
    layout: a.layout || b.layout ? { ...a.layout, ...b.layout } : undefined,
    sizes: a.sizes || b.sizes ? { ...a.sizes, ...b.sizes } : undefined,
    viewport: b.viewport ?? a.viewport,
    ext: a.ext || b.ext ? { ...a.ext, ...b.ext } : undefined,
  };
}

/** True when there is nothing worth writing. */
export function isMetaEmpty(meta: DiagramMeta): boolean {
  const hasLayout = !!meta.layout && Object.keys(meta.layout).length > 0;
  const hasSizes = !!meta.sizes && Object.keys(meta.sizes).length > 0;
  const hasExt = !!meta.ext && Object.keys(meta.ext).length > 0;
  return !hasLayout && !hasSizes && !meta.viewport && !hasExt;
}

/** Compact, deterministic JSON so diffs stay small. Positions are rounded. */
export function serializeMeta(meta: DiagramMeta): string {
  const out: Record<string, unknown> = { v: 1 };
  if (meta.layout && Object.keys(meta.layout).length) {
    const layout: Record<string, Point> = {};
    for (const id of Object.keys(meta.layout).sort()) {
      const [x, y] = meta.layout[id]!;
      layout[id] = [Math.round(x), Math.round(y)];
    }
    out.layout = layout;
  }
  if (meta.sizes && Object.keys(meta.sizes).length) {
    const sizes: Record<string, readonly [number, number]> = {};
    for (const id of Object.keys(meta.sizes).sort()) {
      const [w, h] = meta.sizes[id]!;
      sizes[id] = [Math.round(w), Math.round(h)];
    }
    out.sizes = sizes;
  }
  if (meta.viewport) {
    out.viewport = {
      x: Math.round(meta.viewport.x),
      y: Math.round(meta.viewport.y),
      zoom: Math.round(meta.viewport.zoom * 1000) / 1000,
    };
  }
  if (meta.ext && Object.keys(meta.ext).length) out.ext = meta.ext;
  return JSON.stringify(out);
}

export function metaCommentLine(meta: DiagramMeta, indent = "  "): string {
  return `${indent}${META_COMMENT_PREFIX}${serializeMeta(meta)}`;
}

/**
 * Returns preamble lines with the `pixerate:` frontmatter entry set/removed.
 * Creates a frontmatter block when none exists.
 */
export function writeMetaToPreamble(preamble: Preamble, meta: DiagramMeta | null): string[] {
  const lines = [...preamble.lines];
  const hasFm = lines[0] !== undefined && /^---\s*$/.test(lines[0]);
  const entry =
    meta && !isMetaEmpty(meta) ? `${META_FRONTMATTER_KEY}: ${serializeMeta(meta)}` : null;

  if (!hasFm) {
    if (!entry) return lines;
    return ["---", entry, "---", ...lines];
  }
  const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  const fmEnd = close === -1 ? lines.length : close;
  const existing = lines.findIndex(
    (l, i) => i > 0 && i < fmEnd && new RegExp(`^(?:${META_FRONTMATTER_KEY}|${LEGACY_FRONTMATTER_KEY})\\s*:`).test(l),
  );
  if (existing !== -1) {
    if (entry) lines[existing] = entry;
    else lines.splice(existing, 1);
  } else if (entry) {
    lines.splice(fmEnd, 0, entry);
  }
  // Collapse an emptied frontmatter block.
  if (!entry) {
    const close2 = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (close2 === 1) lines.splice(0, 2);
  }
  return lines;
}

/** Families whose grammar rejects `%%` comments in the body. */
export const FRONTMATTER_META_FAMILIES = new Set(["requirement"]);

export function defaultCarrierFor(family: string): MetaCarrier {
  return FRONTMATTER_META_FAMILIES.has(family) ? "frontmatter" : "comment";
}
