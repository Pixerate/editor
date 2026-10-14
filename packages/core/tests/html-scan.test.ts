import { describe, expect, it } from 'vitest';
import { replaceDelimited, replaceTagSpans, stripTags } from '../src/serializers/html-scan';
import { extractMentions, htmlToPlainText, stripMarkdownCode } from '../src/serializers';

// Reference implementations: the regexes the scanners replaced. They are correct but
// quadratic (or worse) on malformed input, so they are only run on short strings here.
const refStripTags = (html: string, replacement = '') => html.replace(/<[^>]+>/g, replacement);
const refMentionSpans = (html: string, fn: (m: string, attrs: string) => string) =>
  html.replace(/<span\b(?=[^>]*\bdata-type=["']mention["'])([^>]*)>[\s\S]*?<\/span>/gi, fn);
const refStripMarkdownCode = (content: string) =>
  content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/gi, '')
    .replace(/<code[\s\S]*?<\/code>/gi, '')
    .replace(/`[^`\n]*`/g, '');

const PIECES = [
  '<', '>', '<>', '<span', '<SPAN', ' data-type="mention"', " data-type='mention'", ' data-label="Ann"',
  '</span>', '</SPAN>', 'x', ' ', '@bob', '<pre>', '</pre>', '<code>', '</code>', '```', '~~~', '`a`',
  '](', ')', '\n', '<del data-change-type="deletion">', '</del>', '<span-x', '<spanner>',
];

function randomStrings(count: number, seed = 7): string[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(rand() * 14) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join(''),
  );
}

describe('html-scan: same results as the regexes it replaces', () => {
  const inputs = randomStrings(3000);

  it('stripTags matches /<[^>]+>/g', () => {
    for (const input of inputs) {
      expect(stripTags(input)).toBe(refStripTags(input));
      expect(stripTags(input, ' ')).toBe(refStripTags(input, ' '));
    }
  });

  it('replaceTagSpans matches the mention-span regex', () => {
    const fn = (m: string, attrs: string) => `[${attrs.trim()}|${m.length}]`;
    for (const input of inputs) {
      expect(replaceTagSpans(input, 'span', /\bdata-type=["']mention["']/i, fn)).toBe(refMentionSpans(input, fn));
    }
  });

  it('stripMarkdownCode matches the lazy fence/pre/code regexes', () => {
    for (const input of inputs) expect(stripMarkdownCode(input)).toBe(refStripMarkdownCode(input));
  });

  it('replaceDelimited matches /\\]\\([^)]*\\)/g', () => {
    for (const input of inputs) {
      expect(replaceDelimited(input, /\]\(/g, ')', () => ']')).toBe(input.replace(/\]\([^)]*\)/g, ']'));
    }
  });
});

describe('html-scan: linear time on malformed input', () => {
  // Compare growth rather than absolute time (which depends on machine load):
  // linear is ~4x for 4x the input, the quadratic behaviour fixed here is ~16x and
  // the cubic one far more. Best of three runs at each size.
  const growth = (unit: string, run: (s: string) => unknown) => {
    const time = (n: number) => {
      const input = unit.repeat(n);
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        run(input);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    time(500);
    return time(16000) / Math.max(time(4000), 0.5);
  };

  const all = (s: string) => {
    htmlToPlainText(s);
    extractMentions(s);
    stripMarkdownCode(s);
  };

  it.each([
    ["<span data-type='mention' "],
    ["<span class='pixerate-mention-node' "],
    ["<span data-type='mention'>x"],
    ["<del data-change-type='deletion' "],
    ['<'],
    ['<pre>'],
    ['```x'],
    ['](']],
  )('%j', (unit) => {
    expect(growth(unit, all)).toBeLessThan(10);
  }, 30_000);
});
