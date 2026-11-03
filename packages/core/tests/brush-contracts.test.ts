import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRUSH_HOST_PROFILES, BRUSH_JSON_SCHEMA, BRUSH_PRESETS, BRUSH_PROFILE_JSON_SCHEMA, brushContracts, createBrushLibrary, migrateBrushV1, resolveBrush, type Brush } from '../src/brushes';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

const dir = new URL('../../conformance/domains/brushes/', import.meta.url);
const committed = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;
const contracts = brushContracts();

describe('the brush contracts in @pixerate/conformance', () => {
  it('are the files the code exports, with nothing extra (run node scripts/export-contracts.mjs after a change)', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).sort());
  });

  it.each(Object.keys(contracts))('%s matches the code', (name) => {
    expect(committed(name)).toEqual(JSON.parse(JSON.stringify(contracts[name])));
  });

  it('formats every file the way the export script writes it', () => {
    for (const name of Object.keys(contracts)) expect(readFileSync(new URL(name, dir), 'utf8'), name).toBe(JSON.stringify(committed(name), null, 2) + '\n');
  });

  it('has presets that validate against brush.schema.json and profiles against profile.schema.json', () => {
    const schema = committed('brush.schema.json') as JsonSchema;
    for (const b of committed('presets.json') as unknown[]) expect(validateJsonSchema(b, schema), (b as Brush).id).toEqual([]);
    for (const p of committed('profiles.json') as unknown[]) expect(validateJsonSchema(p, committed('profile.schema.json') as JsonSchema)).toEqual([]);
    expect(validateJsonSchema({ id: 'x', name: 'X', kind: 'mark' }, schema).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ ...BRUSH_HOST_PROFILES.paint, light: 'maybe' }, BRUSH_PROFILE_JSON_SCHEMA).length).toBeGreaterThan(0);
  });

  it('describes a library file that export_brushes writes', async () => {
    const library = createBrushLibrary();
    await library.save({ ...BRUSH_PRESETS[0], id: 'mine', name: 'Mine' });
    const file = await library.exportFile();
    // The file schema refers to brush.schema.json for each brush.
    const schema = { ...(committed('library-file.schema.json') as JsonSchema), properties: { ...(committed('library-file.schema.json') as JsonSchema).properties, brushes: { type: 'array', items: BRUSH_JSON_SCHEMA } } } as JsonSchema;
    expect(validateJsonSchema(file, schema)).toEqual([]);
    expect(validateJsonSchema({ ...file, version: 1 }, schema).length).toBeGreaterThan(0);
  });

  it('pairs every preset with the engine brush it resolves to and a check on every host', () => {
    const resolved = committed('resolved.json') as Array<{ id: string; engine: string }>;
    const checks = committed('checks.json') as Array<{ id: string; hosts: Record<string, { ok: boolean }> }>;
    expect(resolved.map((r) => r.id)).toEqual(BRUSH_PRESETS.map((b) => b.id));
    expect(checks.map((c) => c.id)).toEqual(BRUSH_PRESETS.map((b) => b.id));
    for (const c of checks) expect(Object.keys(c.hosts).sort()).toEqual(Object.keys(BRUSH_HOST_PROFILES).sort());
    expect(checks.find((c) => c.id === 'watercolor-wash')!.hosts).toMatchObject({ paint: { ok: true }, canvas: { ok: false }, image: { ok: false } });
    expect(resolved.find((r) => r.id === 'spray-can')!.engine).toBe('dab');
  });

  it('gives migrations whose output resolves back to what the input paints', () => {
    const migrations = committed('migrations.json') as Array<{ input: Parameters<typeof migrateBrushV1>[0]; output: Brush; resolved: unknown }>;
    expect(migrations.length).toBeGreaterThan(10);
    for (const m of migrations) {
      expect(migrateBrushV1(m.input), m.input.id).toEqual(m.output);
      expect(JSON.parse(JSON.stringify(resolveBrush(m.output)))).toMatchObject({ engine: (m.resolved as { engine: string }).engine });
    }
  });

  it('lists the library tools for every host, with paint the only one previewing in this export', () => {
    const tools = committed('tools.json') as { tools: Array<{ name: string; inputSchema: JsonSchema; annotations: object }>; hosts: Record<string, string[]> };
    expect(tools.tools.map((t) => t.name)).toEqual(tools.hosts.paint);
    for (const t of tools.tools) {
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      expect(Object.keys(t.annotations).sort(), t.name).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title']);
    }
    expect(Object.keys(tools.hosts).sort()).toEqual(['canvas', 'image', 'paint', 'vector']);
  });

  it('has a manifest naming every other file and the format version', () => {
    expect(committed('manifest.json')).toMatchObject({ domain: 'brushes', formatVersion: 1, files: Object.keys(contracts).filter((f) => f !== 'manifest.json').sort(), counts: { presets: BRUSH_PRESETS.length } });
  });
});
