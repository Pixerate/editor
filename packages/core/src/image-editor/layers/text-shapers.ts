/**
 * Text shapers for type layers (see `TextShaper` in `text.ts`):
 *
 * - `createCanvasTextShaper`: the browser's own fonts and text drawing through Canvas 2D
 *   (`measureText`, `fillText`). The default in browsers. It cannot give outlines.
 * - `createOutlineTextShaper`: glyph outlines from font objects the host loads, typed after
 *   opentype.js's `Font` (`getPath`, `getAdvanceWidth`, `unitsPerEm`, …) without depending on it.
 *   Pure: it renders anywhere (servers, workers, tests) and makes Convert to Shape possible.
 */

import type { BezierPath } from '../../canvas/pathops/bezier';
import type { TextFont, TextShaper } from './text';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

/** A family as it goes into a CSS `font` value: generics and lists as written, other names quoted when needed. */
export function cssFontFamily(family: string): string {
  const f = family.trim();
  if (GENERIC.has(f.toLowerCase()) || f.includes(',') || /^["']/.test(f)) return f;
  return /^[A-Za-z_-][\w -]*$/.test(f) && !/\s{2}/.test(f) ? f : `"${f.replace(/"/g, '\\"')}"`;
}

/** The CSS `font` shorthand for a font (`italic 700 24px Inter`). */
export function cssFont(font: TextFont, family = font.family): string {
  return `${font.italic ? 'italic ' : ''}${font.weight} ${font.size}px ${cssFontFamily(family)}`;
}

export interface CanvasTextShaperOptions {
  /** A 1 × 1 canvas for measuring (default an `OffscreenCanvas`, else a DOM canvas). */
  createCanvas?(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
  /** Family used when one is missing (default `sans-serif`). */
  fallbackFamily?: string;
}

/**
 * A shaper over Canvas 2D. A family is missing when text set in it measures the same as in
 * both `monospace` and `serif` (the browser fell back), so web fonts must be loaded before use.
 * Returns `null` where there is no 2D canvas.
 */
export function createCanvasTextShaper(options: CanvasTextShaperOptions = {}): TextShaper | null {
  const make =
    options.createCanvas ??
    ((w: number, h: number) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      }
      return null as unknown as HTMLCanvasElement;
    });
  const canvas = make(1, 1);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx || typeof ctx.measureText !== 'function') return null;
  const fallback = options.fallbackFamily ?? 'sans-serif';
  const available = new Map<string, boolean>();
  const widths = new Map<string, number[]>();
  const metrics = new Map<string, { ascent: number; descent: number }>();
  const probe = 'mmmmmmmmmmlli1WQ@#';
  const width = (font: string, text: string) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  const isAvailable = (family: string) => {
    const f = family.trim();
    if (GENERIC.has(f.toLowerCase()) || f.includes(',')) return true;
    let hit = available.get(f);
    if (hit === undefined) {
      const q = cssFontFamily(f);
      hit = width(`72px ${q}, monospace`, probe) !== width('72px monospace', probe) || width(`72px ${q}, serif`, probe) !== width('72px serif', probe);
      available.set(f, hit);
    }
    return hit;
  };
  return {
    id: 'canvas',
    resolve(font) {
      const ok = isAvailable(font.family);
      return { family: ok ? font.family : fallback, available: ok };
    },
    metrics(font) {
      const key = cssFont(font);
      let m = metrics.get(key);
      if (!m) {
        ctx.font = key;
        ctx.textBaseline = 'alphabetic';
        const t = ctx.measureText('Hg') as TextMetrics & { emHeightAscent?: number; emHeightDescent?: number };
        // The em box, as `textBaseline: 'top'` places text (what text annotations used).
        const ascent = t.emHeightAscent ?? t.fontBoundingBoxAscent ?? font.size * 0.8;
        const descent = t.emHeightDescent ?? t.fontBoundingBoxDescent ?? font.size * 0.2;
        m = { ascent: Number.isFinite(ascent) ? ascent : font.size * 0.8, descent: Number.isFinite(descent) ? descent : font.size * 0.2 };
        metrics.set(key, m);
      }
      return m;
    },
    measure(text, font) {
      const key = `${cssFont(font)}|${text}`;
      let w = widths.get(key);
      if (!w) {
        ctx.font = cssFont(font);
        w = [0];
        for (let i = 1; i <= text.length; i++) w.push(ctx.measureText(text.slice(0, i)).width);
        if (widths.size > 2000) widths.clear();
        widths.set(key, w);
      }
      return w;
    },
    draw(target, text, font, x, y) {
      target.font = cssFont(font);
      target.textBaseline = 'alphabetic';
      target.textAlign = 'left';
      target.fillText(text, x, y);
    },
    families() {
      const out = new Set<string>(['sans-serif', 'serif', 'monospace']);
      const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: Iterable<FontFace> }).fonts : undefined;
      if (fonts && typeof (fonts as unknown as { forEach?: unknown }).forEach === 'function') (fonts as unknown as { forEach(cb: (f: FontFace) => void): void }).forEach((f) => out.add(f.family.replace(/^["']|["']$/g, '')));
      return [...out];
    },
  };
}

/** A path command as opentype.js returns it. */
export interface OutlinePathCommand {
  type: 'M' | 'L' | 'C' | 'Q' | 'Z';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** The parts of an opentype.js `Font` the outline shaper uses. */
export interface OutlineFontFace {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
  getPath(text: string, x: number, y: number, fontSize: number, options?: { kerning?: boolean }): { commands: OutlinePathCommand[] };
  names?: { fontFamily?: Record<string, string>; postScriptName?: Record<string, string> };
  tables?: { os2?: { usWeightClass?: number; fsSelection?: number } };
}

/** A face with its family, weight and style (read from the font's names when not given). */
export interface OutlineFontEntry {
  face: OutlineFontFace;
  family?: string;
  weight?: number;
  italic?: boolean;
}

/**
 * A shaper over outline fonts the host loads (opentype.js `Font` objects or anything with the same
 * methods). Fonts are matched by family (case-insensitive), then the nearest weight and the
 * italic flag; a missing family uses `fallback` (default the first font) and is reported missing.
 */
export function createOutlineTextShaper(fonts: ReadonlyArray<OutlineFontFace | OutlineFontEntry>, options: { fallback?: string; id?: string } = {}): TextShaper {
  if (!fonts.length) throw new Error('createOutlineTextShaper needs at least one font.');
  const entries = fonts.map((f) => {
    const e: OutlineFontEntry = 'face' in f ? f : { face: f };
    const names = e.face.names;
    const family = e.family ?? names?.fontFamily?.en ?? Object.values(names?.fontFamily ?? {})[0] ?? 'Font';
    const weight = e.weight ?? e.face.tables?.os2?.usWeightClass ?? 400;
    const italic = e.italic ?? Boolean((e.face.tables?.os2?.fsSelection ?? 0) & 1);
    const postScript = names?.postScriptName?.en ?? Object.values(names?.postScriptName ?? {})[0];
    return { face: e.face, family, key: family.toLowerCase(), weight, italic, postScript };
  });
  const fallbackKey = (options.fallback ?? entries[0].family).toLowerCase();
  const pick = (font: TextFont) => {
    if (font.postScriptName) {
      const exact = entries.find((e) => e.postScript === font.postScriptName);
      if (exact) return { entry: exact, available: true };
    }
    const key = font.family.trim().toLowerCase();
    let pool = entries.filter((e) => e.key === key);
    const available = pool.length > 0;
    if (!available) pool = entries.filter((e) => e.key === fallbackKey);
    if (!pool.length) pool = entries;
    const styled = pool.filter((e) => e.italic === font.italic);
    const list = styled.length ? styled : pool;
    const entry = list.reduce((best, e) => (Math.abs(e.weight - font.weight) < Math.abs(best.weight - font.weight) ? e : best));
    return { entry, available };
  };
  const toPath = (cmds: OutlinePathCommand[]): BezierPath => {
    const out: BezierPath = [];
    for (const c of cmds) {
      if (c.type === 'M' || c.type === 'L') out.push({ type: c.type, x: c.x!, y: c.y! });
      else if (c.type === 'C') out.push({ type: 'C', x1: c.x1!, y1: c.y1!, x2: c.x2!, y2: c.y2!, x: c.x!, y: c.y! });
      else if (c.type === 'Q') out.push({ type: 'Q', x1: c.x1!, y1: c.y1!, x: c.x!, y: c.y! });
      else out.push({ type: 'Z' });
    }
    return out;
  };
  return {
    id: options.id ?? `outline:${entries.map((e) => `${e.family}/${e.weight}${e.italic ? 'i' : ''}`).join(',')}`,
    resolve(font) {
      const { entry, available } = pick(font);
      return { family: entry.family, available };
    },
    metrics(font) {
      const { face } = pick(font).entry;
      const k = font.size / face.unitsPerEm;
      return { ascent: face.ascender * k, descent: -face.descender * k };
    },
    measure(text, font) {
      const { face } = pick(font).entry;
      const out = [0];
      for (let i = 1; i <= text.length; i++) out.push(face.getAdvanceWidth(text.slice(0, i), font.size, { kerning: true }));
      return out;
    },
    outline(text, font, x, y) {
      return toPath(pick(font).entry.face.getPath(text, x, y, font.size, { kerning: true }).commands);
    },
    families() {
      return [...new Set(entries.map((e) => e.family))];
    },
  };
}
