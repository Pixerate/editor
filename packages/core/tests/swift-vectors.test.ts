import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hash2, mix32, rand01, randSigned, seedFromString, TileableNoise } from '../src/paint/rand';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';
import { migrateDocument } from '../src/persistence/migrate';

/**
 * Test vectors the Swift core (`packages/swift`, `PixerateCore`) checks itself against: the
 * seeded RNG bit for bit, JSON number formatting, schema validation messages and document
 * migration. Computed here from the TS core; a drift from the committed file fails this test
 * (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun the Swift tests).
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateCoreTests/Fixtures/core-vectors.json');

function vectors() {
  const ints = [0, 1, -1, 7, 42, 255, 65535, 2147483647, -2147483648, 4294967295, 123456789, -987654321];
  const mix = ints.map((n) => [n >>> 0, mix32(n >>> 0)]);
  const hash: [number, number, number, number][] = [];
  for (const x of [0, 1, -3, 1000, 2147483647]) for (const y of [0, 5, -7, 65536]) for (const s of [0, 3, 99, -12345]) hash.push([x, y, s, hash2(x, y, s)]);
  const rand = [[0, 0, 0], [12, 3, 51], [99, 1000, 7], [-5, 17, 2], [2147483647, 1, 1]].map(([seed, i, st]) => [seed, i, st, rand01(seed, i, st), randSigned(seed, i, st)]);
  const seeds = ['', 'a', 'paper', 'cold-pressed', 'Ünïcödé', '🎨 emoji', 'a'.repeat(100)].map((t) => [t, seedFromString(t)]);
  const noise = new TileableNoise(256, 4, 3, 4, 1234);
  const noiseSamples = [[0, 0], [10.5, 3.25], [255.9, 255.9], [256, 0], [-17, 512.5], [128, 64]].map(([x, y]) => [x, y, noise.at(x, y)]);
  const numbers = [0, -0, 1, -1, 0.1, 1.5, 100, 1e21, 1e-7, 1.5e-7, 123456789.123, 1e20, 0.000001, 0.0000015, 2 ** 53, -1e-300, 5e-324, 1.7976931348623157e308, 1 / 3];
  const schemaCases: Array<{ name: string; value: unknown; schema: JsonSchema }> = [
    { name: 'type mismatch', value: 'x', schema: { type: 'number' } },
    { name: 'type union', value: null, schema: { type: ['string', 'integer'] } },
    { name: 'integer vs number', value: 1.5, schema: { type: 'integer' } },
    { name: 'enum', value: 'c', schema: { enum: ['a', 'b', 1, null] } },
    { name: 'const', value: { a: 1 }, schema: { const: { a: 2 } } },
    { name: 'string bounds', value: 'héllo😀', schema: { type: 'string', minLength: 10, maxLength: 3, pattern: '^[a-z]+$' } },
    { name: 'number bounds', value: 7, schema: { type: 'number', minimum: 8, maximum: 6, exclusiveMinimum: 7, exclusiveMaximum: 7, multipleOf: 0.5 } },
    { name: 'multipleOf ok', value: 0.3, schema: { multipleOf: 0.1 } },
    { name: 'array', value: [1, 1, 'x'], schema: { type: 'array', minItems: 4, maxItems: 2, uniqueItems: true, items: { type: 'integer' } } },
    {
      name: 'object',
      value: { b: 1, nmae: 'x', 2: true, 1: false },
      schema: { type: 'object', properties: { name: { type: 'string' }, b: { type: 'string' } }, required: ['name', 'id'], additionalProperties: false },
    },
    { name: 'additional schema', value: { a: 1, b: 'x' }, schema: { type: 'object', additionalProperties: { type: 'number' } } },
    {
      name: 'anyOf closest',
      value: { kind: 'circle', r: 'big' },
      schema: { anyOf: [{ type: 'object', properties: { kind: { const: 'circle' }, r: { type: 'number' } }, required: ['kind', 'r'] }, { type: 'string' }] },
    },
    { name: 'oneOf many', value: 5, schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] } },
    { name: 'allOf and not', value: 'x', schema: { allOf: [{ type: 'string' }, { minLength: 2 }], not: { const: 'x' } } },
    {
      name: 'refs',
      value: { item: { id: 3 }, other: {} },
      schema: { $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }, type: 'object', properties: { item: { $ref: '#/$defs/item' }, other: { $ref: '#/$defs/missing' } } },
    },
    { name: 'ref cycle', value: 1, schema: { $ref: '#' } },
    {
      name: 'tool arguments',
      value: { layerId: 'L1', kind: 'outer-glow', settings: { size: 999, blend: 'screen', colr: '#fff' } },
      schema: {
        type: 'object',
        properties: {
          layerId: { type: 'string' },
          kind: { type: 'string', enum: ['outer-glow', 'inner-glow'] },
          settings: { type: 'object', properties: { size: { type: 'number', minimum: 0, maximum: 250 }, blend: { type: 'string' }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, additionalProperties: false },
        },
        required: ['layerId', 'kind'],
        additionalProperties: false,
      },
    },
  ];
  const schema = schemaCases.map((c) => ({ ...c, errors: validateJsonSchema(c.value, c.schema) }));
  const stringify = [{ b: 1, a: [1, 'two', null, true, { '10': 1, '2': 2, x: 3 }], s: 'quote " back \\ nl \n tab \t ctl \u0001 é 😀' }, [], {}, [1.5e-7, 1e21, -0]].map((v) => ({ value: v, text: JSON.stringify(v), pretty: JSON.stringify(v, null, 2) }));
  const step = (from: number) => (doc: Record<string, unknown>) => ({ ...doc, [`v${from + 1}`]: true });
  const migrations = [
    { name: 'from 1 to 3', input: { version: 1, keep: 'me' } },
    { name: 'missing version', input: { keep: 'me' } },
    { name: 'newer', input: { version: 9 } },
    { name: 'not an object', input: [1, 2] },
    { name: 'failing step', input: { version: 0 } },
  ].map((c) => {
    const { doc, report } = migrateDocument(c.input, { currentVersion: 3, steps: { 0: () => { throw new Error('boom'); }, 1: step(1), 2: step(2) } });
    return { ...c, doc, report };
  });
  return { mix, hash, rand, seeds, noise: { size: 256, cellsX: 4, cellsY: 3, octaves: 4, salt: 1234, samples: noiseSamples }, numbers: numbers.map((n) => [n, JSON.stringify(n)]), schema, stringify, migrations };
}

describe('Swift core test vectors', () => {
  it('match the committed fixture (the Swift tests read it)', () => {
    const now = JSON.stringify(vectors(), null, 1) + '\n';
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, now);
    expect(readFileSync(FILE, 'utf8')).toBe(now);
  });
});
