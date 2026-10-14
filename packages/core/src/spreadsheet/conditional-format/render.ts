/**
 * CSS for the conditional look of a cell, shared by the React and Svelte
 * grids (React uses the objects, Svelte the `style` strings).
 */
import type { ConditionalCellFormat } from './types';

export interface ConditionalFormatCss {
  background?: string;
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

/**
 * Black or white, whichever reads better on `fill` (`#rgb` / `#rrggbb`), or
 * undefined for other colour syntaxes.
 */
export function conditionalFormatContrastColor(fill: string): string | undefined {
  let hex = fill.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  // Perceived brightness (ITU-R BT.601 weights).
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.55 ? '#1f2328' : '#ffffff';
}

/**
 * Fill, font colour and emphasis of a cell (no data bar or icon). A fill
 * without a font colour of its own gets black or white text, so the value
 * stays readable whatever the theme's text colour (Excel's fills assume
 * dark text).
 */
export function getConditionalFormatCss(format: ConditionalCellFormat | undefined): ConditionalFormatCss {
  if (!format) return {};
  const css: ConditionalFormatCss = {};
  if (format.fill) css.background = format.fill;
  if (format.color) css.color = format.color;
  else if (format.fill) {
    const contrast = conditionalFormatContrastColor(format.fill);
    if (contrast) css.color = contrast;
  }
  if (format.bold) css.fontWeight = '700';
  if (format.italic) css.fontStyle = 'italic';
  const decorations = [format.underline ? 'underline' : '', format.strikethrough ? 'line-through' : ''].filter(Boolean);
  if (decorations.length) css.textDecoration = decorations.join(' ');
  return css;
}

/** The bar element of a data bar: absolutely placed from the cell's left edge. */
export function getDataBarCss(bar: NonNullable<ConditionalCellFormat['dataBar']>): Record<string, string> {
  const width = `${Math.round(Math.min(Math.max(bar.fraction, 0), 1) * 1000) / 10}%`;
  return {
    position: 'absolute',
    left: '0',
    top: '2px',
    bottom: '2px',
    width,
    pointerEvents: 'none',
    borderRadius: '1px',
    background: bar.gradient
      ? `linear-gradient(90deg, ${bar.color}, color-mix(in srgb, ${bar.color} 20%, transparent))`
      : bar.color,
    opacity: bar.gradient ? '0.9' : '0.75',
  };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `{ fontWeight: '700' }` → `font-weight: 700;` for `style` attributes. */
export function conditionalFormatStyleString(css: Record<string, string | undefined> | ConditionalFormatCss): string {
  let out = '';
  for (const [key, value] of Object.entries(css)) {
    if (value !== undefined && value !== '') out += `${kebab(key)}: ${value}; `;
  }
  return out.trim();
}
