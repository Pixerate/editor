import type { OutlineFontFace, OutlinePathCommand } from '../../src/image-editor';

/**
 * A font for tests: 1000 units per em, ascender 800, descender −200; every character advances
 * 600 units (a space 300) and draws a box from 50 to 550 units wide and 700 units tall above the
 * baseline (a space draws nothing). Pairs `AV` kern by −100 units.
 */
export function boxFont(family = 'Box', weight = 400): OutlineFontFace & { family: string } {
  const adv = (c: string) => (c === ' ' ? 300 : 600);
  const width = (text: string) => {
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      w += adv(text[i]);
      if (text[i] === 'A' && text[i + 1] === 'V') w -= 100;
    }
    return w;
  };
  return {
    family,
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    names: { fontFamily: { en: family } },
    tables: { os2: { usWeightClass: weight, fsSelection: 0 } },
    getAdvanceWidth: (text, size) => (width(text) * size) / 1000,
    getPath: (text, x, y, size) => {
      const k = size / 1000;
      const commands: OutlinePathCommand[] = [];
      let at = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c !== ' ') {
          const x0 = x + (at + 50) * k;
          const x1 = x + (at + 550) * k;
          commands.push({ type: 'M', x: x0, y }, { type: 'L', x: x1, y }, { type: 'L', x: x1, y: y - 700 * k }, { type: 'L', x: x0, y: y - 700 * k }, { type: 'Z' });
        }
        at += adv(c);
        if (c === 'A' && text[i + 1] === 'V') at -= 100;
      }
      return { commands };
    },
  };
}
