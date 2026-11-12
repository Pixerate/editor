import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, memoryStyleStore } from '../src/tools';
import { VectorEditorController, createVectorStyleToolProvider, vectorStyleDomain, vectorStyleSurface } from '../src/vector';
import { createFakeStickerProvider, createStickerStyleToolProvider, stickerStyleDomain } from '../src/stickers';
import { BRUSH_PRESETS, brushStyleDomain, createBrushLibrary, createBrushStyleToolProvider, type Brush } from '../src/brushes';
import { createEffectAuthoringStyleToolProvider, createFakeEffectProvider, effectAuthoringStyleDomain, type EffectAuthoringSession } from '../src/effects';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [vectorStyleDomain, stickerStyleDomain, brushStyleDomain, effectAuthoringStyleDomain]
	});

const drawingIds = (c: VectorEditorController) => c.getDocument().nodes.map((n) => n.id);

describe('vector house style', () => {
	const drawing = () => {
		const c = new VectorEditorController();
		const a = c.addPath('M0 0 L100 0 L100 100 L0 100 Z', { name: 'Card', fill: '#9933cc', stroke: '#000000', strokeWidth: 3 });
		const b = c.addPath('M200 0 L300 0', { name: 'Rule', stroke: '#000000', strokeWidth: 2 });
		c.setCornerRadius(6, { ids: [a] });
		return { c, a, b };
	};

	it('stroke widths and corner radii snap to the nearest house value; colours are the surface', async () => {
		const { c, a } = drawing();
		const styles = resolver('vector', { strokeWidths: [1, 2, 4], cornerRadii: [4, 8], checks: ['stroke-widths', 'corner-radii', 'palette-only'] }, { colors: { primary: '#000000' } });
		const report = await styles.check('vector', c.getState());
		const by = (check: string) => report.findings.filter((f) => f.check === check).map((f) => f.target);
		expect(by('stroke-widths')).toEqual([{ node: a, property: 'strokeWidth', value: 2 }]);
		expect(by('corner-radii')).toHaveLength(4);
		expect(by('corner-radii')[0]).toMatchObject({ node: a, property: 'corner', value: 4 });
		expect(by('palette-only')).toEqual([{ node: a, property: 'fill' }]);
		expect(vectorStyleSurface(c.getState()).colors?.filter((x) => x.use === 'stroke').map((x) => x.target)).toEqual([{ node: a, property: 'stroke' }, { node: drawingIds(c)[1], property: 'stroke' }]);
	});

	it('fix_vector_style snaps them as one undo step and leaves colours; read-only hides it', async () => {
		const { c, a, b } = drawing();
		let readOnly: string | false = false;
		const styles = resolver('vector', { strokeWidths: [1, 2, 4], cornerRadii: [4, 8], checks: ['stroke-widths', 'corner-radii', 'palette-only'] }, { colors: { primary: '#000000' } });
		const registry = new ToolRegistry();
		registry.register(createVectorStyleToolProvider(c, styles, { namespace: '', readOnly: () => readOnly }));
		c.select([b]);
		const fix = await registry.callTool('fix_vector_style', {});
		expect(fix.isError).toBeFalsy();
		expect(fix.structuredContent).toMatchObject({ strokeWidths: { [a]: 2 }, left: [expect.objectContaining({ check: 'palette-only' })] });
		expect((fix.structuredContent as { corners: unknown[] }).corners).toHaveLength(4);
		const node = c.getDocument().nodes.find((n) => n.id === a) as any;
		expect(node.strokeWidth).toBe(2);
		expect(node.subpaths[0].anchors.every((x: any) => x.corner?.radius === 4)).toBe(true);
		expect(c.getState().selection).toEqual([b]);
		c.undo();
		const before = c.getDocument().nodes.find((n) => n.id === a) as any;
		expect(before.strokeWidth).toBe(3);
		expect(before.subpaths[0].anchors[0].corner.radius).toBe(6);
		const check = await registry.callTool('check_vector_style', {});
		expect((check.structuredContent as { ok: boolean }).ok).toBe(false);
		readOnly = 'locked';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_vector_style']);
	});
});

describe('sticker house style', () => {
	const setup = (profile: Record<string, unknown>, brand?: Record<string, unknown>) => {
		const registry = new ToolRegistry();
		const provider = createFakeStickerProvider();
		registry.register(createStickerStyleToolProvider(resolver('stickers', profile, brand), { provider: () => provider, namespace: '' }));
		return registry;
	};

	it('checks stickers by ref: libraries, collections, licence, AI art, tags and tints', async () => {
		const registry = setup({ libraries: ['acme'], collections: ['kitchen'], commercialOnly: true, allowAiGenerated: false, bannedTags: ['drawing'], checks: ['libraries', 'collections', 'commercial', 'ai-art', 'banned-tags', 'palette-only'] }, { colors: { primary: '#0b5fff' } });
		const result = await registry.callTool('check_sticker_style', { stickers: [{ ref: 'fake:fruit-apple' }, { ref: 'fake:art-sketch' }, { ref: 'fake:weather-sun' }, { ref: 'fake:badge-new', color: '#ff0000' }] });
		expect(result.isError).toBeFalsy();
		const out = result.structuredContent as { findings: { check: string; target: { ref: string } }[]; filters: unknown };
		const refs = (check: string) => out.findings.filter((f) => f.check === check).map((f) => f.target.ref);
		expect(refs('libraries')).toEqual(['fake:fruit-apple', 'fake:art-sketch', 'fake:weather-sun', 'fake:badge-new']);
		expect(refs('collections')).toEqual(['fake:art-sketch', 'fake:weather-sun', 'fake:badge-new']);
		expect(refs('commercial')).toEqual(['fake:art-sketch']);
		expect(refs('ai-art')).toEqual(['fake:weather-sun']);
		expect(refs('banned-tags')).toEqual(['fake:art-sketch']);
		expect(refs('palette-only')).toEqual(['fake:badge-new']);
		expect(out.filters).toEqual({ commercial: true, collection: 'kitchen' });
	});

	it('refuses an unknown ref with the closest ones, and a bad tint', async () => {
		const registry = setup({ libraries: ['fake'], checks: ['libraries'] });
		const bad = await registry.callTool('check_sticker_style', { stickers: [{ ref: 'fake:fruit-appel' }] });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toContain('fake:fruit-apple');
		expect((await registry.callTool('check_sticker_style', { stickers: [{ ref: 'fake:fruit-apple', color: 'red' }] })).isError).toBe(true);
		expect((await registry.callTool('check_sticker_style', { stickers: [] })).isError).toBe(true);
		const ok = await registry.callTool('check_sticker_style', { stickers: [{ ref: 'fake:fruit-apple' }] });
		expect(ok.structuredContent).toMatchObject({ ok: true, filters: {} });
		expect(registry.listTools().tools[0].annotations?.readOnlyHint).toBe(true);
	});
});

describe('brush house style', () => {
	const own: Brush = { ...BRUSH_PRESETS.find((b) => b.id === 'marker')!, id: 'house-marker', name: 'House marker', colour: { default: '#9933cc', palette: ['#0b5fff'] } };

	it('checks saved brushes by default and any brushes by id', async () => {
		const library = createBrushLibrary();
		await library.save(own);
		const registry = new ToolRegistry();
		registry.register(createBrushStyleToolProvider(library, resolver('brushes', { brushes: ['pencil-hb', 'house-marker'], media: ['dry'], checks: ['brushes', 'media', 'palette-only'] }, { colors: { primary: '#0b5fff' } }), { namespace: '' }));
		const saved = await registry.callTool('check_brush_style', {});
		expect(saved.structuredContent).toMatchObject({ checked: ['house-marker'] });
		expect((saved.structuredContent as { findings: { check: string; target: unknown }[] }).findings.map((f) => [f.check, f.target])).toEqual([
			['media', { brush: 'house-marker' }],
			['palette-only', { brush: 'house-marker', colour: 'default' }]
		]);
		const picked = await registry.callTool('check_brush_style', { ids: ['pencil-hb', 'airbrush'] });
		expect((picked.structuredContent as { findings: { check: string; target: unknown }[] }).findings.map((f) => [f.check, f.target])).toEqual([
			['brushes', { brush: 'airbrush' }],
			['media', { brush: 'airbrush' }]
		]);
		const unknown = await registry.callTool('check_brush_style', { ids: ['pencil-hbb'] });
		expect(unknown.isError).toBe(true);
		expect(JSON.stringify(unknown.content)).toContain('pencil-hb');
	});

	it('source-licences flags image sources a brush uses with no licence', async () => {
		const styles = resolver('brushes', { requireSourceLicence: true, checks: ['source-licences'] });
		const stamp: Brush = { ...own, id: 'stamped', tip: { ...own.tip, shape: 'stamp', stamps: ['source:leaf', 'source:fern'] } };
		const report = await styles.check('brushes', {
			brushes: [{ brush: stamp, builtin: false }],
			sources: [
				{ id: 'leaf', name: 'Leaf', origin: 'leaves.abr' },
				{ id: 'fern', name: 'Fern', licence: 'CC0' },
				{ id: 'unused', name: 'Unused' }
			]
		});
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([['source-licences', { source: 'leaf' }]]);
		expect(report.findings[0].message).toContain('stamped');
	});
});

describe('effect authoring house style', () => {
	const open = async () => (await createFakeEffectProvider().openAuthoring!({ effectId: 'fake.tint' })) as EffectAuthoringSession;

	it('languages, timing, presets and colour controls', async () => {
		const session = await open();
		session.setTiming({ duration: 9000, loop: false });
		const styles = resolver('effect-authoring', { languages: ['pixel'], maxDuration: 4000, loop: true, presets: ['Sepia', 'Strong'], checks: ['languages', 'timing', 'presets', 'palette-only'] }, { colors: { primary: '#0b5fff' } });
		const report = await styles.check('effect-authoring', session.getState());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['timing', { timing: { duration: 4000 } }],
			['timing', { timing: { loop: true } }],
			['presets', { preset: 'Strong' }],
			['palette-only', { control: 'color' }]
		]);
		// The fake tint has no editable source, so languages passes; a GLSL effect does not.
		const glsl = await styles.check('effect-authoring', { ...session.getState(), sourceLanguage: 'glsl' as const });
		expect(glsl.findings[0]).toMatchObject({ check: 'languages', severity: 'error', target: { source: 'glsl' } });
	});

	it('fix sets the house timing as one undo step; no session refuses; read-only hides it', async () => {
		let session: EffectAuthoringSession | null = await open();
		session.setTiming({ duration: 9000, loop: false });
		let readOnly = false;
		const registry = new ToolRegistry();
		registry.register(createEffectAuthoringStyleToolProvider({ session: () => session }, resolver('effect-authoring', { maxDuration: 4000, loop: true, presets: ['Strong'], checks: ['timing', 'presets'] }), { namespace: '', readOnly: () => readOnly }));
		const fix = await registry.callTool('fix_effect_authoring_style', {});
		expect(fix.structuredContent).toMatchObject({ timing: { duration: 4000, loop: true }, duration: 4000, loop: true, left: [expect.objectContaining({ check: 'presets' })] });
		session.undo();
		expect(session.getState()).toMatchObject({ duration: 9000, loop: false });
		readOnly = true;
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_effect_authoring_style']);
		session = null;
		const none = await registry.callTool('check_effect_authoring_style', {});
		expect(none.isError).toBe(true);
		expect(JSON.stringify(none.content)).toContain('No effect is open');
	});
});
