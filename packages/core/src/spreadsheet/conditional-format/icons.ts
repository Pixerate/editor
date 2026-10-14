/**
 * Glyphs for conditional-format icon sets, so React and Svelte draw the same
 * icons without image assets. Index 0 is the lowest icon.
 */
import type { ConditionalFormatIconSet } from './types';

export interface ConditionalFormatIconGlyph {
  /** Text glyph to draw. */
  glyph: string;
  /** CSS colour of the glyph. */
  color: string;
  /** Accessible name, e.g. "Up arrow". */
  label: string;
}

const RED = '#d9534f';
const YELLOW = '#e0a800';
const GREEN = '#2e9d4f';
const GRAY = '#7a7f87';
const BLACK = '#3b3f45';
const BLUE = '#3b73b9';

const g = (glyph: string, color: string, label: string): ConditionalFormatIconGlyph => ({ glyph, color, label });

const ICON_SETS: Record<ConditionalFormatIconSet, ConditionalFormatIconGlyph[]> = {
  '3Arrows': [g('↓', RED, 'Down arrow'), g('→', YELLOW, 'Side arrow'), g('↑', GREEN, 'Up arrow')],
  '3ArrowsGray': [g('↓', GRAY, 'Down arrow'), g('→', GRAY, 'Side arrow'), g('↑', GRAY, 'Up arrow')],
  '3TrafficLights1': [g('●', RED, 'Red light'), g('●', YELLOW, 'Yellow light'), g('●', GREEN, 'Green light')],
  '3Flags': [g('⚑', RED, 'Red flag'), g('⚑', YELLOW, 'Yellow flag'), g('⚑', GREEN, 'Green flag')],
  '3Symbols': [g('✖', RED, 'Cross'), g('!', YELLOW, 'Exclamation'), g('✔', GREEN, 'Check')],
  '3Stars': [g('☆', YELLOW, 'Empty star'), g('✬', YELLOW, 'Half star'), g('★', YELLOW, 'Full star')],
  '4Arrows': [g('↓', RED, 'Down arrow'), g('↘', YELLOW, 'Down-right arrow'), g('↗', YELLOW, 'Up-right arrow'), g('↑', GREEN, 'Up arrow')],
  '4Rating': [g('▂', BLUE, 'Rating 1 of 4'), g('▄', BLUE, 'Rating 2 of 4'), g('▆', BLUE, 'Rating 3 of 4'), g('█', BLUE, 'Rating 4 of 4')],
  '4TrafficLights': [g('●', BLACK, 'Black light'), g('●', RED, 'Red light'), g('●', YELLOW, 'Yellow light'), g('●', GREEN, 'Green light')],
  '5Arrows': [
    g('↓', RED, 'Down arrow'),
    g('↘', YELLOW, 'Down-right arrow'),
    g('→', YELLOW, 'Side arrow'),
    g('↗', GREEN, 'Up-right arrow'),
    g('↑', GREEN, 'Up arrow'),
  ],
  '5Rating': [
    g('▁', BLUE, 'Rating 1 of 5'),
    g('▂', BLUE, 'Rating 2 of 5'),
    g('▄', BLUE, 'Rating 3 of 5'),
    g('▆', BLUE, 'Rating 4 of 5'),
    g('█', BLUE, 'Rating 5 of 5'),
  ],
  '5Quarters': [g('○', BLACK, 'Empty'), g('◔', BLACK, 'Quarter'), g('◑', BLACK, 'Half'), g('◕', BLACK, 'Three quarters'), g('●', BLACK, 'Full')],
};

/** Names of the built-in icon sets. */
export const CONDITIONAL_FORMAT_ICON_SETS = Object.keys(ICON_SETS) as ConditionalFormatIconSet[];

/** Number of icons in a set (`3Arrows` → 3), always 3 to 5. */
export function conditionalFormatIconCount(set: string): number {
  const n = Number(set.charAt(0));
  return Number.isFinite(n) ? Math.min(5, Math.max(3, n)) : 3;
}

/** The glyph of icon `index` of `set` (unknown sets use traffic lights). */
export function getConditionalFormatIcon(set: string, index: number): ConditionalFormatIconGlyph {
  const icons = ICON_SETS[set as ConditionalFormatIconSet] ?? ICON_SETS['3TrafficLights1'];
  return icons[Math.max(0, Math.min(icons.length - 1, index))];
}
