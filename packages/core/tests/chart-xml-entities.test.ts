import { describe, expect, it } from 'vitest';
import { chartFallbackDomParser } from '../src/chart/contract';

/** The fallback DOMParser's entity decoding (#767): no prototype names, no RangeError. */
const text = (inner: string): string | null => new chartFallbackDomParser().parseFromString(`<a>${inner}</a>`, 'application/xml').documentElement.textContent;
const attr = (value: string): string | null => new chartFallbackDomParser().parseFromString(`<a v="${value}"/>`, 'application/xml').documentElement.getAttribute('v');

describe('chart fallback XML entities', () => {
  it('decodes the five XML entities and character references', () => {
    expect(text('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;')).toBe('<>&"\'AB😀');
  });

  it('leaves names every object inherits as text', () => {
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString', 'propertyIsEnumerable', 'nbsp']) {
      expect(text(`&${name};`), name).toBe(`&${name};`);
      expect(attr(`&${name};`), name).toBe(`&${name};`);
    }
  });

  it('leaves references past U+10FFFF or to a surrogate as text instead of throwing', () => {
    for (const ref of ['&#x110000;', '&#1114112;', '&#xFFFFFFFFFFFFFFFFFFFF;', `&#${'9'.repeat(400)};`, '&#xD800;', '&#57343;']) {
      expect(() => text(ref), ref).not.toThrow();
      expect(text(ref), ref).toBe(ref);
      expect(attr(ref), ref).toBe(ref);
    }
    expect(text('&#x10FFFF;')).toBe(String.fromCodePoint(0x10ffff));
  });
});
