import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, memoryStyleStore } from '../src/tools';
import { ImageEditorController, createImageStyleToolProvider, imageStyleDomain, imageStyleSurface } from '../src/image-editor';
import { PaintEditorController, createPaintStyleToolProvider, paintStyleDomain, paintStyleSurface } from '../src/paint-editor';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [imageStyleDomain, paintStyleDomain]
	});

const image = (width = 1200, height = 1000) => {
	const fake = { width, height, naturalWidth: width, naturalHeight: height, src: 'data:fake' } as unknown as HTMLImageElement;
	return new ImageEditorController({ image: fake });
};

describe('image house style', () => {
	it('aspect-ratio (with the centred crop), min-size and adjustment-ranges', async () => {
		const c = image();
		c.setAdjustments({ saturation: 60, contrast: -40 });
		const styles = resolver('image-editor', { aspectRatios: ['1:1', '4:5'], minSize: { width: 1500 }, adjustments: { saturation: { min: -20, max: 20 }, contrast: { min: -10 } }, checks: ['aspect-ratio', 'min-size', 'adjustment-ranges'] });
		const report = await styles.check('image-editor', c.getState());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['aspect-ratio', { crop: { x: 100, y: 0, width: 1000, height: 1000 } }],
			['min-size', { image: true }],
			['adjustment-ranges', { adjustment: 'contrast', value: -10 }],
			['adjustment-ranges', { adjustment: 'saturation', value: 20 }]
		]);
		// Cropping to the suggestion satisfies the ratio.
		c.setCrop({ x: 100, y: 0, width: 1000, height: 1000 });
		expect((await styles.check('image-editor', c.getState())).findings.map((f) => f.check)).not.toContain('aspect-ratio');
	});

	it('annotation colours and fonts are the surface for the brand checks', async () => {
		const c = image();
		c.addAnnotation({ type: 'text', x: 10, y: 10, text: 'Sale', fontSize: 24, color: '#9933cc', fontFamily: 'Comic Sans MS' } as any);
		const surface = imageStyleSurface(c.getState());
		expect(surface.colors?.map((x) => x.color)).toContain('#9933cc');
		expect(surface.fonts?.map((f) => f.family)).toEqual(['Comic Sans MS']);
		const styles = resolver('image-editor', { checks: ['palette-only', 'fonts-allowed'] }, { colors: { primary: '#0b5fff' }, fonts: { body: 'Inter' } });
		expect((await styles.check('image-editor', c.getState())).findings.map((f) => f.check)).toEqual(['palette-only', 'fonts-allowed']);
	});

	it('check and fix through the tools, one undo step; hidden when read-only', async () => {
		const c = image();
		c.setAdjustments({ saturation: 60 });
		let readOnly: string | false = false;
		const styles = resolver('image-editor', { aspectRatios: ['1:1'], adjustments: { saturation: { max: 20 } }, checks: ['aspect-ratio', 'adjustment-ranges'] });
		const registry = new ToolRegistry();
		registry.register(createImageStyleToolProvider(c, styles, { namespace: '', readOnly: () => readOnly }));
		expect((await registry.callTool('check_image_style', {})).structuredContent).toMatchObject({ ok: false });
		const fix = await registry.callTool('fix_image_style', {});
		expect(fix.structuredContent).toMatchObject({ fixed: { saturation: 20 }, left: [expect.objectContaining({ check: 'aspect-ratio' })] });
		expect(c.getState().adjustments.saturation).toBe(20);
		c.undo();
		expect(c.getState().adjustments.saturation).toBe(60);
		readOnly = 'Approved for print.';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_image_style']);
		expect((await registry.callTool('fix_image_style', {})).isError).toBe(true);
	});
});

describe('paint house style', () => {
	it('paper, brushes and max-layers', async () => {
		const c = new PaintEditorController({ width: 64, height: 64 });
		c.setPaper({ preset: 'cartridge' });
		c.setBrush({ id: 'airbrush' });
		c.addLayer();
		c.addLayer();
		const styles = resolver('paint-editor', { papers: ['cold-pressed', 'hot-pressed'], brushes: ['watercolor-round', 'pencil-hb'], maxLayers: 2, checks: ['paper', 'brushes', 'max-layers'] });
		const report = await styles.check('paint-editor', c.getState());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['paper', { paper: 'cold-pressed' }],
			['brushes', { brush: 'watercolor-round' }],
			['max-layers', { painting: true }]
		]);
	});

	it('rejects a paper that is not in the library when the profile loads', async () => {
		const styles = resolver('paint-editor', { papers: ['no-such-paper'] });
		expect((await styles.list())[0].issues[0]).toMatch(/paint-editor\.json is left out: \/papers\/0: Expected one of/);
	});

	it('the current colour, swatches and stroke colours are the surface for the brand checks', async () => {
		const c = new PaintEditorController({ width: 64, height: 64 });
		c.setColor('#9933cc');
		c.addSwatch('#0b5fff', 'Brand blue');
		const surface = paintStyleSurface(c.getState());
		expect(surface.colors?.slice(0, 2).map((x) => [x.label, x.color])).toEqual([
			['The current colour', '#9933cc'],
			expect.arrayContaining([expect.stringMatching(/Swatch \d+/)])
		]);
		const styles = resolver('paint-editor', { checks: ['palette-only'] }, { colors: { primary: '#0b5fff' } });
		const findings = (await styles.check('paint-editor', c.getState())).findings;
		expect(findings.map((f) => f.target)).toContainEqual({ color: 'current' });
	});

	it('check and fix through the tools; hidden when read-only', async () => {
		const c = new PaintEditorController({ width: 64, height: 64 });
		c.setPaper({ preset: 'cartridge' });
		c.setBrush({ id: 'airbrush' });
		let readOnly: string | false = false;
		const styles = resolver('paint-editor', { papers: ['cold-pressed'], brushes: ['watercolor-round'], checks: ['paper', 'brushes'] });
		const registry = new ToolRegistry();
		registry.register(createPaintStyleToolProvider(c, styles, { namespace: '', readOnly: () => readOnly }));
		const fix = await registry.callTool('fix_paint_style', {});
		expect(fix.structuredContent).toEqual({ changed: { paper: 'cold-pressed', brush: 'watercolor-round' }, left: [] });
		expect(c.getState().document.paper.preset).toBe('cold-pressed');
		expect(c.getState().brush.id).toBe('watercolor-round');
		expect((await registry.callTool('check_paint_style', {})).structuredContent).toMatchObject({ ok: true });
		readOnly = 'locked';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_paint_style']);
	});
});
