import { describe, expect, it, vi } from 'vitest';
import {
  BRUSH_PRESETS,
  CANVAS_PROFILE,
  IMAGE_PROFILE,
  PAINT_PROFILE,
  VECTOR_PROFILE,
  BrushLibraryError,
  checkBrush,
  createBrushLibrary,
  createBrushLibraryToolProvider,
  degrade,
  listPresets,
  parseBrushLibrary,
  type Brush,
} from '../src/brushes';
import { BUILTIN_BRUSHES, brushToJSON } from '../src/paint-editor/brushes';
import { listCanvasBrushes } from '../src/canvas/brushstrokeRender';
import { vectorBrushstrokeBrushes } from '../src/vector/brushstroke';
import { createMemoryStorage } from '../src/persistence';
import { renderBrushThumbnail } from '../src/paint-editor/thumbnails';
import { DEFAULT_PAPER } from '../src/paint-editor/paper';
import { bytesToBase64, decodePng, encodePng, base64ToBytes } from '../src/raster/png';
import { resolveBrush } from '../src/brushes';
import { ToolRegistry } from '../src/tools';

const ids = (brushes: readonly { id: string }[]) => brushes.map((b) => b.id);
const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;

describe('host profiles', () => {
  // The brushes canvas and vector strokes used before their hand-written filters were replaced by
  // these profiles (canvas: dry dab brushes without light; vector: dry dab brushes). The profiles
  // must keep listing exactly these presets.
  // Since then the new dry and ink presets were added, and both hosts render them; the spray can's
  // scatter marks are the paint editor's alone.
  const ADDED = ['ballpoint', 'gel-pen', 'fineliner', 'crayon', 'chalk'];
  const CANVAS_BEFORE = ['pencil-hb', 'pencil-6b', 'soft-pastel', 'oil-pastel', 'charcoal-stick', 'vine-charcoal', 'airbrush', 'marker', 'ink-pen', 'brush-pen', 'dirty-round', 'multicolor-flat', 'palette-dabber', 'gradient-round', 'pressure-ombre', 'rainbow-marker'];
  const VECTOR_BEFORE = [...CANVAS_BEFORE, 'neon-marker', 'light-airbrush', 'highlighter'];

  it('lets canvas use exactly the brushes its hand-written filter allowed', () => {
    expect(ids(listPresets(CANVAS_PROFILE))).toEqual([...CANVAS_BEFORE, ...ADDED]);
    expect(ids(listCanvasBrushes())).toEqual([...CANVAS_BEFORE, ...ADDED]);
  });

  // #519: vector brushstrokes also paint wet media, the Mixer Brush, smudge and blender.
  const VECTOR_MEDIA = ['blender', 'smudge', 'wet-smudge', 'mixer-brush', 'watercolor-round', 'watercolor-wash', 'gradient-wash', 'watercolor-detail', 'gouache', 'oil-round', 'oil-flat', 'glow-wash'];

  it('lets vector use the brushes its hand-written filter allowed, plus wet, mixer, smudge and blender brushes', () => {
    const order = ids(BRUSH_PRESETS);
    const expected = [...VECTOR_BEFORE, ...ADDED, ...VECTOR_MEDIA].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    expect(ids(listPresets(VECTOR_PROFILE))).toEqual(expected);
    expect(ids(vectorBrushstrokeBrushes())).toEqual(expected);
  });

  it('still refuses the wet tools, thick paint, particles, stickers and erasers on vector, with reasons', () => {
    for (const id of ['add-water', 'wet-blend', 'blot', 'impasto-brush', 'hair-strands', 'sticker-stars', 'eraser-soft', 'bristle-round']) {
      const check = checkBrush(preset(id), VECTOR_PROFILE);
      expect(check.ok, id).toBe(false);
      for (const issue of check.issues.filter((i) => i.severity === 'error')) expect(issue.fix, id).toBeTruthy();
    }
    expect(checkBrush(preset('add-water'), VECTOR_PROFILE).issues[0]).toMatchObject({ facet: 'tool', severity: 'error' });
    expect(checkBrush(preset('paint-tube'), VECTOR_PROFILE).issues).toContainEqual(expect.objectContaining({ facet: 'behaviour.surface', severity: 'error' }));
  });

  it('lets the paint editor use every preset', () => {
    expect(ids(listPresets(PAINT_PROFILE))).toEqual(ids(BRUSH_PRESETS));
    for (const b of BRUSH_PRESETS) expect(checkBrush(b, PAINT_PROFILE).issues, b.id).toEqual([]);
  });

  it('gives the image editor its dry brushes, the Mixer Brush and erasers, not wet, thick, particle or sticker brushes', () => {
    const image = ids(listPresets(IMAGE_PROFILE));
    expect(image).toEqual(expect.arrayContaining(['pencil-hb', 'airbrush', 'mixer-brush', 'eraser-soft', 'eraser-hard']));
    for (const no of ['watercolor-round', 'impasto-brush', 'hair-strands', 'sticker-stars', 'bristle-round', 'blender', 'highlighter']) expect(image).not.toContain(no);
  });

  it('explains each refusal with the facet and a fix', () => {
    const c = checkBrush(preset('glow-wash'), CANVAS_PROFILE);
    expect(c.ok).toBe(false);
    expect(c.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ facet: 'behaviour.surface', severity: 'error', fix: 'Set behaviour.surface to dry.' }),
        expect.objectContaining({ facet: 'light', severity: 'error', fix: 'Remove light (or set light.amount to 0).' }),
      ]),
    );
    const tool = checkBrush(preset('blender'), IMAGE_PROFILE);
    expect(tool.issues).toEqual([expect.objectContaining({ facet: 'tool', severity: 'error', fix: 'Use one of: eraser.' })]);
  });

  it('warns about what a host paints without', () => {
    const ink = checkBrush(preset('ink-pen'), CANVAS_PROFILE);
    expect(ink.ok).toBe(true);
    expect(ink.issues).toEqual([expect.objectContaining({ facet: 'dynamics.velocity', severity: 'warning' })]);
    const light = checkBrush(preset('highlighter'), VECTOR_PROFILE);
    expect(light.ok).toBe(true);
    expect(light.issues.map((i) => i.facet)).toEqual(['light']);
  });

  it('degrades a brush to what the host renders and reports what it dropped', () => {
    const d = degrade(preset('bokeh-dots'), CANVAS_PROFILE);
    expect(d.dropped.map((i) => i.facet).sort()).toEqual(['light', 'marks', 'tip.shape']);
    expect(d.brush.tip.shape).toBe('round');
    expect(d.brush.tip.stamps).toBeUndefined();
    expect(d.brush.marks).toBeUndefined();
    expect(d.brush.light).toBeUndefined();
    expect(d.issues).toEqual([]);
    expect(checkBrush(d.brush, CANVAS_PROFILE).ok).toBe(true);
    expect(preset('bokeh-dots').marks?.kind).toBe('particles');

    const mixer = degrade(preset('mixer-brush'), CANVAS_PROFILE);
    expect(mixer.brush.behaviour?.exchange).toBeUndefined();
    expect(checkBrush(mixer.brush, CANVAS_PROFILE).ok).toBe(true);

    const tool = degrade(preset('smudge'), CANVAS_PROFILE);
    expect(tool.issues.map((i) => i.facet)).toEqual(['kind']);
  });
});

describe('parseBrushLibrary', () => {
  it('reads a version 1 file through migration', () => {
    const problems: string[] = [];
    const v1 = { format: 'pixerate-brushes', version: 1, brushes: BUILTIN_BRUSHES.slice(0, 3).map(brushToJSON) };
    expect(parseBrushLibrary(v1, problems)).toEqual(BRUSH_PRESETS.slice(0, 3).map((b) => expect.objectContaining({ id: b.id, kind: b.kind, tip: b.tip, dynamics: b.dynamics })));
    expect(problems).toEqual([]);
  });

  it('reads version 2 files, bare arrays and JSON text, and reports what it skips', () => {
    const problems: string[] = [];
    const brushes = parseBrushLibrary(
      JSON.stringify([
        { id: 'a', name: 'A', kind: 'mark', tip: { shape: 'round', size: 9000 } },
        { id: 'Bad', name: 'B' },
        { id: 'c' },
        { id: 'd', name: 'D', engine: 'eraser' },
        'x',
      ]),
      problems,
    );
    expect(brushes.map((b) => [b.id, b.kind])).toEqual([
      ['a', 'mark'],
      ['d', 'tool'],
    ]);
    expect(brushes[0].tip.size).toBe(2500);
    expect(problems).toEqual([
      expect.stringMatching(/^brushes\[0\] \("a"\): brush\.tip\.size 9000 is out of range/),
      expect.stringMatching(/^brushes\[1\] has no valid id/),
      expect.stringMatching(/^brushes\[2\] \("c"\) has no name/),
      expect.stringMatching(/^brushes\[4\] is not an object/),
    ]);
  });

  it('refuses what is not a library', () => {
    expect(() => parseBrushLibrary({ brushes: 1 })).toThrow(/Not a brush library/);
    expect(() => parseBrushLibrary({ format: 'pixerate-brushes', version: 3, brushes: [] })).toThrow(/version 3 is not supported/);
    expect(() => parseBrushLibrary('{')).toThrow(/not JSON/);
  });
});

describe('BrushLibrary', () => {
  const mine: Brush = { id: 'my-ink', name: 'My ink', kind: 'mark', medium: 'ink', tip: { shape: 'round', size: 6 } };

  it('lists the presets, then user brushes, and filters them', async () => {
    const lib = createBrushLibrary();
    await lib.save(mine);
    const all = await lib.list();
    expect(all).toHaveLength(BRUSH_PRESETS.length + 1);
    expect(all.at(-1)).toEqual({ brush: mine, builtin: false });
    expect(ids((await lib.list({ source: 'user' })).map((e) => e.brush))).toEqual(['my-ink']);
    expect(ids((await lib.list({ variety: 'watercolor' })).map((e) => e.brush))).toEqual(['watercolor-round', 'watercolor-wash', 'gradient-wash', 'watercolor-detail', 'glow-wash', 'ghost-wash', 'invisible-ink', 'mutation-wash']);
    expect(ids((await lib.list({ tool: 'eraser' })).map((e) => e.brush))).toEqual(['eraser-soft', 'eraser-hard']);
    expect(ids((await lib.list({ text: 'oil pas' })).map((e) => e.brush))).toEqual(['oil-pastel']);
    expect((await lib.list({ profile: CANVAS_PROFILE })).length).toBe(listCanvasBrushes().length + 1);
  });

  it('keeps user brushes on the storage adapter across libraries', async () => {
    const storage = createMemoryStorage();
    const a = createBrushLibrary({ storage });
    await a.save(mine);
    await a.duplicate('pencil-hb');
    const b = createBrushLibrary({ storage });
    expect(ids((await b.list({ source: 'user' })).map((e) => e.brush))).toEqual(['my-ink', 'pencil-hb-copy']);
    expect((await b.get('pencil-hb-copy'))?.brush).toEqual({ ...preset('pencil-hb'), id: 'pencil-hb-copy', name: 'HB pencil copy' });
    expect(JSON.parse((await storage.get('pixerate.brushes:user'))!)).toMatchObject({ format: 'pixerate-brushes', version: 2 });
  });

  it('protects built-in ids and taken ids', async () => {
    const lib = createBrushLibrary();
    await expect(lib.save({ ...mine, id: 'pencil-hb' })).rejects.toThrow(/built-in brush .* duplicate it first/);
    await expect(lib.remove('pencil-hb')).rejects.toThrow(BrushLibraryError);
    await lib.save(mine);
    await expect(lib.save(mine)).rejects.toThrow(/exists already/);
    expect((await lib.save({ ...mine, name: 'Renamed' }, { overwrite: true })).replaced).toBe(true);
    expect(await lib.remove('my-ink')).toBe(true);
    expect(await lib.remove('my-ink')).toBe(false);
    await expect(lib.duplicate('nope')).rejects.toThrow(/No brush "nope"/);
  });

  it('numbers duplicates and notifies subscribers after each change', async () => {
    const lib = createBrushLibrary();
    const listener = vi.fn();
    const off = lib.subscribe(listener);
    expect((await lib.duplicate('marker')).id).toBe('marker-copy');
    expect((await lib.duplicate('marker')).id).toBe('marker-copy-2');
    await lib.save(mine);
    await lib.remove('my-ink');
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    await lib.save(mine);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('exports version 2 and imports v1 and v2, skipping built-in and taken ids', async () => {
    const lib = createBrushLibrary();
    await lib.save(mine);
    const file = await lib.exportFile();
    expect(file).toEqual({ format: 'pixerate-brushes', version: 2, brushes: [mine] });
    expect((await lib.exportFile(['marker'])).brushes).toEqual([preset('marker')]);

    const other = createBrushLibrary();
    expect(await other.importFile(file)).toEqual({ added: ['my-ink'], replaced: [], skipped: [], problems: [] });
    const v1 = { format: 'pixerate-brushes', version: 1, brushes: [{ ...brushToJSON(BUILTIN_BRUSHES[0]), id: 'old-pencil', name: 'Old pencil' }, brushToJSON(BUILTIN_BRUSHES[1])] };
    const r = await other.importFile(v1);
    expect(r.added).toEqual(['old-pencil']);
    expect(r.skipped).toEqual(['pencil-6b']);
    expect(r.problems).toEqual([expect.stringMatching(/"pencil-6b" is a built-in brush id/)]);
    expect((await other.get('old-pencil'))?.brush).toEqual({ ...preset('pencil-hb'), id: 'old-pencil', name: 'Old pencil' });
    expect((await other.importFile(file)).skipped).toEqual(['my-ink']);
    expect((await other.importFile(file, { overwrite: true })).replaced).toEqual(['my-ink']);
  });
});

describe('brush library tools', () => {
  const setup = (options: Parameters<typeof createBrushLibraryToolProvider>[1] = {}) => {
    const library = createBrushLibrary();
    const registry = new ToolRegistry({ namespaces: 'on-collision' });
    registry.register(createBrushLibraryToolProvider(library, options));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await registry.callTool(name, args);
      const text = (r.content?.[0] as { text?: string })?.text ?? '';
      return { error: r.isError ? text : null, result: r.structuredContent as any, content: r.content };
    };
    return { library, registry, call };
  };

  it('registers the read and write tools, and preview_brush only with a renderer', () => {
    const names = (o?: Parameters<typeof setup>[0]) => setup(o).registry.listTools().tools.map((t) => t.name).sort();
    expect(names()).toEqual(['add_brush_source', 'check_brush', 'create_brush', 'describe_brush', 'duplicate_brush', 'export_brushes', 'import_brush_pack', 'import_brushes', 'list_brush_presets', 'list_brush_sources', 'remove_brush', 'update_brush']);
    expect(names({ renderPreview: () => ({ data: '', mimeType: 'image/png' }) })).toContain('preview_brush');
    expect(names({ readOnly: true })).toEqual(['check_brush', 'describe_brush', 'export_brushes', 'list_brush_presets', 'list_brush_sources']);
  });

  it('lists what the host renders, with summaries', async () => {
    const { call } = setup({ profile: CANVAS_PROFILE });
    const { result } = await call('list_brush_presets');
    expect(result.host).toBe('canvas');
    expect(result.brushes.map((b: { id: string }) => b.id)).toEqual(ids(listCanvasBrushes()));
    expect(result.brushes[0]).toEqual({ id: 'pencil-hb', name: 'HB pencil', builtin: true, kind: 'mark', medium: 'dry', variety: 'pencil', category: 'pencil', engine: 'dab', tip: 'round', size: 4, marks: 'continuous', surface: 'dry' });
    const all = await call('list_brush_presets', { all: true, kind: 'tool', limit: 3 });
    expect(all.result.total).toBe(11);
    expect(all.result.brushes).toHaveLength(3);
    expect(all.result.brushes.every((b: { renderable: boolean }) => b.renderable === false)).toBe(true);
    expect((await call('list_brush_presets', { medium: 'clay' })).error).toMatch(/medium/);
  });

  it('describes a brush and refuses an unknown id with the closest ones', async () => {
    const { call } = setup();
    const { result } = await call('describe_brush', { id: 'highlighter' });
    expect(result).toMatchObject({ builtin: true, engine: 'dab', category: 'light', check: { ok: true, issues: [] }, brush: { variety: 'highlighter' } });
    expect((await call('describe_brush', { id: 'pencil-h' })).error).toMatch(/No brush "pencil-h"\. Closest: pencil-hb/);
  });

  it('creates a brush based on a preset, normalised and checked', async () => {
    const { call, library } = setup();
    const { result, error } = await call('create_brush', { id: 'soft-ink', name: 'Soft ink', basedOn: 'ink-pen', tip: { shape: 'round', hardness: 0.4 }, dynamics: { velocitySize: 0 }, tags: ['ink'] });
    expect(error).toBeNull();
    expect(result.id).toBe('soft-ink');
    expect(result.engine).toBe('dab');
    expect(result.brush).toMatchObject({ kind: 'mark', medium: 'ink', tip: { size: 4, hardness: 0.4 }, dynamics: { minSize: 0.25, velocitySize: 0 }, tags: ['ink'] });
    expect((await library.get('soft-ink'))?.builtin).toBe(false);
  });

  it('refuses a brush the host can\'t render, and saves nothing', async () => {
    const { call, library } = setup({ profile: CANVAS_PROFILE });
    const { error } = await call('create_brush', { id: 'wet', name: 'Wet', basedOn: 'watercolor-round' });
    expect(error).toMatch(/Canvas can't use this brush: behaviour\.surface: Canvas has no wet surface\. Set behaviour\.surface to dry\./);
    expect(await library.get('wet')).toBeNull();
    const ok = await call('create_brush', { id: 'dry', name: 'Dry', basedOn: 'watercolor-round', behaviour: { surface: 'dry' } });
    expect(ok.error).toBeNull();
  });

  it('refuses taken ids, built-in ids, out-of-range values and unknown fields', async () => {
    const { call } = setup();
    expect((await call('create_brush', { id: 'marker', name: 'X' })).error).toMatch(/built-in brush id/);
    await call('create_brush', { id: 'mine', name: 'Mine' });
    expect((await call('create_brush', { id: 'mine', name: 'Again' })).error).toMatch(/exists already/);
    expect((await call('create_brush', { id: 'big', name: 'Big', tip: { shape: 'round', size: 99999 } })).error).toMatch(/tip\/size/);
    expect((await call('create_brush', { id: 'eng', name: 'Eng', engine: 'dab' })).error).toMatch(/engine/);
    expect((await call('create_brush', { id: 'x', name: 'X', basedOn: 'nope' })).error).toMatch(/No brush "nope"/);
  });

  it('updates a saved brush, merging facets and unsetting whole ones', async () => {
    const { call } = setup();
    await call('create_brush', { id: 'glow', name: 'Glow', basedOn: 'neon-marker' });
    const { result, error } = await call('update_brush', { id: 'glow', tip: { size: 20 }, unset: ['light'], name: 'Dim' });
    expect(error).toBeNull();
    expect(result.brush.light).toBeUndefined();
    expect(result.brush.tip).toMatchObject({ shape: 'round', size: 20, hardness: 0.9 });
    expect(result.changed.sort()).toEqual(['light', 'name', 'tip.size']);
    expect((await call('update_brush', { id: 'marker', tip: { size: 1 } })).error).toMatch(/built-in brush and can't be changed; duplicate_brush/);
    expect((await call('update_brush', { id: 'nope' })).error).toMatch(/No brush "nope"/);
  });

  it('refuses an update the host can\'t render', async () => {
    const { call, library } = setup({ profile: CANVAS_PROFILE });
    await call('create_brush', { id: 'plain', name: 'Plain', basedOn: 'pencil-hb' });
    expect((await call('update_brush', { id: 'plain', light: { amount: 1 } })).error).toMatch(/light: Canvas can't paint light paint/);
    expect((await library.get('plain'))?.brush.light).toBeUndefined();
  });

  it('duplicates any brush and removes only saved ones', async () => {
    const { call } = setup();
    expect((await call('duplicate_brush', { id: 'gouache' })).result.id).toBe('gouache-copy');
    expect((await call('duplicate_brush', { id: 'gouache', newId: 'my-gouache', name: 'Mine' })).result.brush).toMatchObject({ id: 'my-gouache', name: 'Mine', variety: 'gouache' });
    expect((await call('remove_brush', { id: 'gouache-copy' })).result).toEqual({ removed: 'gouache-copy' });
    expect((await call('remove_brush', { id: 'gouache' })).error).toMatch(/built-in brush and can't be removed/);
    expect((await call('remove_brush', { id: 'gouache-copy' })).error).toMatch(/No brush "gouache-copy"/);
  });

  it('exports and imports library files', async () => {
    const a = setup();
    await a.call('duplicate_brush', { id: 'airbrush', newId: 'my-air' });
    const { result } = await a.call('export_brushes');
    expect(result.file.brushes.map((b: Brush) => b.id)).toEqual(['my-air']);
    const b = setup();
    expect((await b.call('import_brushes', { file: result.file })).result).toEqual({ added: ['my-air'], replaced: [], skipped: [], problems: [] });
    expect((await b.call('import_brushes', { file: { brushes: 'x' } })).error).toMatch(/Not a brush library/);
    expect((await b.call('export_brushes', { ids: ['nope'] })).error).toMatch(/No brush "nope"/);
  });

  it('checks a brush for another host, with the degraded brush', async () => {
    const { call } = setup();
    const { result } = await call('check_brush', { id: 'light-airbrush', host: 'canvas' });
    expect(result).toMatchObject({ host: 'canvas', ok: false, degraded: { dropped: [{ facet: 'light' }], issues: [] } });
    const spec = await call('check_brush', { brush: { id: 'p', name: 'P', kind: 'mark', tip: { shape: 'round' }, marks: { kind: 'particles' } }, host: 'image' });
    expect(spec.result.issues).toEqual([expect.objectContaining({ facet: 'marks', severity: 'error' })]);
    expect((await call('check_brush', {})).error).toMatch(/either id .* or brush/);
    expect((await call('check_brush', { id: 'pencil-hb', host: 'swift' })).error).toMatch(/host/);
  });

  it('previews with the paint engine, as the demo wires it', async () => {
    const { call } = setup({
      renderPreview: (brush, { width, height, color }) => {
        const t = renderBrushThumbnail(resolveBrush(brush), { paper: DEFAULT_PAPER, width, height, color });
        return { data: bytesToBase64(encodePng(t.width, t.height, t.data)), mimeType: 'image/png' };
      },
    });
    const r = await call('preview_brush', { id: 'ink-pen', width: 64, height: 32, color: '#000000' });
    expect(r.error).toBeNull();
    const png = decodePng(base64ToBytes((r.content![0] as { data: string }).data));
    expect([png.width, png.height]).toEqual([64, 32]);
    // The stroke darkens some pixels well below the paper.
    let darkest = 255;
    for (let i = 0; i < png.data.length; i += 4) darkest = Math.min(darkest, png.data[i]);
    expect(darkest).toBeLessThan(120);
  });

  it('previews through the host renderer', async () => {
    const render = vi.fn(() => ({ data: 'AAAA', mimeType: 'image/png' }));
    const { call } = setup({ renderPreview: render });
    const r = await call('preview_brush', { id: 'highlighter', width: 128 });
    expect(r.content).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
    expect(r.result).toEqual({ id: 'highlighter', width: 128, height: 96 });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ id: 'highlighter' }), { width: 128, height: 96, color: '#fff200' });
    expect((await call('preview_brush', { id: 'x', width: 10 })).error).toMatch(/width/);
  });
});
