/**
 * Shared text model: character and paragraph styles over runs of plain text, and the `TextShaper`
 * interface through which layout reaches fonts. Used by the image editor's type layers and the
 * vector editor's text nodes, so both lay text out the same way. No DOM and no third-party code.
 */
import type { BezierPath } from '../canvas/pathops/bezier';

/** An axis-aligned rectangle. */
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The character style of a run of text (Photoshop's Character panel). Sizes are document pixels;
 * tracking is in 1/1000 em.
 */
export interface TextStyle {
  /** Family name ("Inter"); fonts the system lacks fall back to a generic family, with a warning. */
  fontFamily: string;
  /** CSS weight, 100..900 (default 400). */
  fontWeight: number;
  /** Default false. */
  italic?: boolean;
  /** Font size in pixels. */
  fontSize: number;
  /** `#rrggbb`. */
  color: string;
  /** 0..1 (missing = 1). */
  opacity?: number;
  /** Letter spacing in 1/1000 em (missing = 0). */
  tracking?: number;
  /** Baseline-to-baseline distance in pixels; missing = auto (the paragraph's `autoLeading` × size). */
  leading?: number;
  /** Pixels; positive raises the text (missing = 0). */
  baselineShift?: number;
  underline?: boolean;
  strikethrough?: boolean;
  /** PostScript name from a PSD (`ArialMT`), kept so the exact face can be found and written back. */
  postScriptName?: string;
  /**
   * Vertical text only: set Latin and other horizontal-script characters upright, one under the
   * other, instead of turned sideways (Photoshop's Standard Vertical Roman Alignment off). Default
   * false. No effect on horizontal text.
   */
  upright?: boolean;
}

/**
 * Which way text runs. `horizontal`: lines left to right, stacked downwards. `vertical`: columns
 * top to bottom, stacked right to left; CJK characters stand upright and other scripts are turned
 * 90° clockwise (unless their style is `upright`).
 */
export type TextOrientation = 'horizontal' | 'vertical';
export const TEXT_ORIENTATIONS: readonly TextOrientation[] = ['horizontal', 'vertical'];

/** A character style over `length` UTF-16 code units of the text, in order. */
export interface TextRun {
  length: number;
  style: TextStyle;
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right', 'justify'];

/** Paragraph style (Photoshop's Paragraph panel); lengths in pixels. */
export interface ParagraphStyle {
  /** Default `left`. `justify` stretches every line of a paragraph box but the last. */
  align?: TextAlign;
  /** Auto leading as a multiple of the font size (default 1.2). */
  autoLeading?: number;
  firstLineIndent?: number;
  startIndent?: number;
  endIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

/** A paragraph style over `length` UTF-16 code units (whole paragraphs, line break included). */
export interface ParagraphRun {
  length: number;
  style: ParagraphStyle;
}

/** A font as a shaper is asked for it (sizes in pixels). */
export interface TextFont {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  postScriptName?: string;
}

/** How a shaper sets a character upright in a vertical column (pixels). */
export interface TextVerticalMetrics {
  /** Advance down the column. */
  advance: number;
  /** Distance from the top of the character's cell to its horizontal baseline. */
  originY: number;
  /** Whether the font has a vertical alternate (OpenType `vert`) the shaper draws with `{ vertical: true }`. */
  alternate: boolean;
}

/** Options for drawing or outlining text. */
export interface TextGlyphOptions {
  /** Use the font's vertical alternates (`vert`), for upright characters in vertical text. */
  vertical?: boolean;
}

/**
 * What layout and rendering need from fonts. Implement `outline` (glyph outlines, pure) or `draw`
 * (onto a 2D canvas), or both.
 */
export interface TextShaper {
  /** Identifies the shaper (part of the render cache key). */
  readonly id: string;
  /** The family that draws `font`: the family itself when available, else a fallback (`available: false`). */
  resolve(font: TextFont): { family: string; available: boolean };
  /** Ascent and descent (both positive, pixels) of the resolved font at `font.size`. */
  metrics(font: TextFont): { ascent: number; descent: number };
  /**
   * Caret positions of `text` set in `font`: `text.length + 1` x offsets in pixels from the start
   * (kerning included, tracking not).
   */
  measure(text: string, font: TextFont): ArrayLike<number>;
  /** Glyph outlines of `text` with its start on the baseline at (`x`, `y`), pixels, y down. */
  outline?(text: string, font: TextFont, x: number, y: number, options?: TextGlyphOptions): BezierPath;
  /** Draws `text` with its start on the baseline at (`x`, `y`) in the context's current transform, fill style and alpha. */
  draw?(ctx: CanvasRenderingContext2D, text: string, font: TextFont, x: number, y: number, options?: TextGlyphOptions): void;
  /**
   * Vertical metrics of one character (a code point) set upright, from the font's `vhea` / `vmtx`.
   * Optional: without it, vertical layout uses the font's ascent + descent as the advance and its
   * ascent as the origin, and has no vertical alternates (brackets and dashes are then turned
   * sideways, and 、。 moved to the upper right of their cell).
   */
  vertical?(char: string, font: TextFont): TextVerticalMetrics;
  /** Families this shaper can draw (for font pickers and agents), when it can tell. */
  families?(): string[];
}
