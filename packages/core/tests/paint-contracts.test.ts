import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRUSH_JSON_SCHEMA } from '../src/brushes';
import { createFakeEffectProvider } from '../src/effects';
import { PAINT_SHORTCUTS, PaintEditorController, createPaintEditorDocument, paintContracts, paintShortcutFor } from '../src/paint-editor';
import { toEditorDocumentFile } from '../src/persistence/editorDocument';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

const dir = new URL('../../conformance/domains/paint/', import.meta.url);
const committed = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;
const contracts = paintContracts({ effects: createFakeEffectProvider() });

/** document.schema.json with its stroke brush reference resolved to the brush schema. */
function documentSchema(): JsonSchema {
  const schema = committed('document.schema.json') as any;
  schema.properties.document.properties.strokes.items.properties.brush = BRUSH_JSON_SCHEMA;
  return schema as JsonSchema;
}

describe('the paint contracts in @pixerate/conformance', () => {
  it('are the files the code exports, with nothing extra (run node scripts/export-contracts.mjs after a change)', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).sort());
  });

  it.each(Object.keys(contracts))('%s matches the code', (name) => {
    expect(committed(name)).toEqual(JSON.parse(JSON.stringify(contracts[name])));
  });

  it('formats every file the way the export script writes it', () => {
    for (const name of Object.keys(contracts)) expect(readFileSync(new URL(name, dir), 'utf8'), name).toBe(JSON.stringify(committed(name), null, 2) + '\n');
  });

  it('describes a painting the editor saves, strokes and all, and refuses one that is not', async () => {
    const controller = new PaintEditorController({ width: 48, height: 32 });
    await controller.paintStroke({ points: [{ x: 2, y: 2, pressure: 0.4 }, { x: 30, y: 20 }] });
    controller.addLayer();
    const file = JSON.parse(JSON.stringify(toEditorDocumentFile(createPaintEditorDocument(controller), 'Sketch')));
    expect(file.document.strokes.length).toBe(1);
    expect(validateJsonSchema(file, documentSchema())).toEqual([]);
    expect(validateJsonSchema({ ...file, kind: 'image' }, documentSchema()).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ ...file, document: { ...file.document, version: 3 } }, documentSchema()).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ ...file, document: { ...file.document, strokes: [{ ...file.document.strokes[0], brush: { id: 'x' } }] } }, documentSchema()).length).toBeGreaterThan(0);
  });

  it('lists every paint tool with a strict schema, a title and all four annotations', () => {
    const { providers } = committed('tools.json') as { providers: Array<{ id: string; tools: Array<{ name: string; title: string; description: string; inputSchema: JsonSchema; annotations: object }> }> };
    expect(providers.map((p) => p.id)).toEqual(['paint-editor', 'paint-effects', 'brushes', 'paint-proposals']);
    const names = providers.flatMap((p) => p.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['paint_stroke', 'set_brush', 'undo_paint', 'apply_effect', 'create_brush', 'advance_wet_paint']));
    for (const t of providers.flatMap((p) => p.tools)) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(Object.keys(t.annotations).sort(), t.name).toEqual(expect.arrayContaining(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']));
    }
  });

  it('lists the keyboard commands the editors handle, each matched by its own keys', () => {
    const commands = committed('commands.json') as Array<{ id: string; keys: string[]; tool?: string; params: JsonSchema }>;
    expect(commands.map((c) => c.id)).toEqual(PAINT_SHORTCUTS.map((s) => s.id));
    const press = (combo: string) => {
      const parts = combo.split('+');
      const key = parts.pop()!;
      return { key: key.length === 1 ? key.toLowerCase() : key, ctrlKey: parts.includes('Mod'), shiftKey: parts.includes('Shift') };
    };
    for (const c of commands) for (const k of c.keys) expect(paintShortcutFor(press(k))?.id, k).toBe(c.id);
    expect(paintShortcutFor({ key: 'q' })).toBeNull();
    expect(paintShortcutFor({ key: 'b', metaKey: true })).toBeNull();
    const tools = (committed('tools.json') as { providers: Array<{ tools: Array<{ name: string }> }> }).providers.flatMap((p) => p.tools.map((t) => t.name));
    for (const c of commands) if (c.tool) expect(tools, c.id).toContain(c.tool);
  });

  it('gives the UI tables React and Svelte render', () => {
    const ui = committed('ui.json') as { tools: Array<{ id: string; key: string }>; layerEffects: Array<{ kind: string; controls: unknown[] }>; sliders: Record<string, unknown> };
    expect(ui.tools.map((t) => t.id)).toContain('brush');
    expect(ui.layerEffects.length).toBe(10);
    for (const e of ui.layerEffects) expect(e.controls.length, e.kind).toBeGreaterThan(0);
    expect(Object.keys(ui.sliders)).toEqual(['paper', 'wet', 'wetTilt', 'wetSpeed', 'light', 'uvLight', 'age', 'viewTilt', 'ghost', 'mutation', 'culture', 'livePatterns', 'stroke', 'sticker', 'magnet', 'antimatter']);
  });

  it('has a manifest naming every other file, the format version and the document versions', () => {
    expect(committed('manifest.json')).toMatchObject({ domain: 'paint', formatVersion: 1, document: { kind: 'paint', format: 'pixerate-paint', version: 2 }, files: Object.keys(contracts).filter((f) => f !== 'manifest.json').sort() });
  });
});
