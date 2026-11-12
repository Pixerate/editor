import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, memoryStyleStore } from '../src/tools';
import { canvasStyleDomain, canvasStyleSurface, createCanvasStyleToolProvider, type CanvasNode } from '../src/canvas';
import { createFontPicker, createTypographyStyleToolProvider, typographyStyleDomain, type FontSummary } from '../src/typography';
import { HistoryManager } from '../src/history';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [canvasStyleDomain, typographyStyleDomain]
	});

const NODES = (): CanvasNode[] => [
	// React Flow style object
	{ id: 'card', position: { x: 13, y: 16 }, data: { label: 'Card' }, style: { backgroundColor: '#9933cc', color: '#ffffff', borderRadius: 6, borderWidth: 3, fontSize: 15, fontFamily: 'Comic Sans MS' } },
	// SvelteFlow style string
	{ id: 'note', position: { x: 32, y: 40 }, data: { label: 'Note' }, style: 'background: #0b5fff; border-radius: 8px; font-size: 16px;' },
	// A shape node: its paint lives in data.shape
	{ id: 'box', position: { x: 0, y: 0 }, data: { shape: { kind: 'rect', fill: '#0b5fff', stroke: '#111111', strokeWidth: 1, cornerRadius: 4 } } }
];

describe('canvas house style', () => {
	it('corner-radii, stroke-widths, font-sizes and grid, over style objects, strings and shapes', async () => {
		const styles = resolver('canvas', { cornerRadii: [0, 4, 8], strokeWidths: [1, 2], fontSizes: [12, 16, 20], grid: 8, checks: ['corner-radii', 'stroke-widths', 'font-sizes', 'grid'] });
		const report = await styles.check('canvas', { nodes: NODES() });
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['corner-radii', { node: 'card', property: 'cornerRadius', value: 4 }],
			['stroke-widths', { node: 'card', property: 'strokeWidth', value: 2 }],
			['font-sizes', { node: 'card', property: 'fontSize', value: 16 }],
			['grid', { node: 'card', property: 'position', value: { x: 16, y: 16 } }]
		]);
	});

	it('fills, strokes, text colours and fonts are the surface for the brand checks', async () => {
		const surface = canvasStyleSurface({ nodes: NODES() });
		expect(surface.colors?.map((c) => [c.label, c.use, c.color])).toEqual([
			['Node card ("Card") fill', 'background', '#9933cc'],
			['Node card ("Card") text', 'text', '#ffffff'],
			['Node note ("Note") fill', 'background', '#0b5fff'],
			['Node box fill', 'background', '#0b5fff'],
			['Node box stroke', 'stroke', '#111111']
		]);
		expect(surface.fonts).toEqual([{ family: 'Comic Sans MS', label: 'Node card ("Card")', target: { node: 'card', property: 'fontFamily' } }]);
		const styles = resolver('canvas', { checks: ['palette-only', 'fonts-allowed'] }, { colors: { primary: '#0b5fff', text: '#111111' }, fonts: { body: 'Inter' } });
		const report = await styles.check('canvas', { nodes: NODES() });
		expect(report.findings.map((f) => [f.check, (f.target as any).node])).toEqual([
			['palette-only', 'card'],
			['fonts-allowed', 'card']
		]);
	});

	it('check and fix through the tools as one undoable command; hidden when read-only', async () => {
		let nodes = NODES();
		let readOnly: string | false = false;
		const history = new HistoryManager();
		const styles = resolver('canvas', { cornerRadii: [0, 4, 8], strokeWidths: [1, 2], fontSizes: [12, 16, 20], grid: 8, checks: ['corner-radii', 'stroke-widths', 'font-sizes', 'grid', 'palette-only'] }, { colors: { primary: '#0b5fff' } });
		const registry = new ToolRegistry();
		registry.register(createCanvasStyleToolProvider(styles, { getNodes: () => nodes, setNodes: (n) => (nodes = n), history, namespace: '', readOnly: () => readOnly }));
		expect((await registry.callTool('check_canvas_style', {})).structuredContent).toMatchObject({ ok: false, fixable: 4 });
		const before = nodes;
		const fix = await registry.callTool('fix_canvas_style', {});
		expect(fix.structuredContent).toMatchObject({ fixed: 4, left: [expect.objectContaining({ check: 'palette-only' })] });
		expect(nodes[0]).toMatchObject({ position: { x: 16, y: 16 }, style: { borderRadius: 4, borderWidth: 2, fontSize: 16 } });
		// The other nodes are the same objects: only what changed was replaced.
		expect(nodes[1]).toBe(before[1]);
		history.undo();
		expect(nodes).toBe(before);
		readOnly = 'The board is shared read-only.';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_canvas_style']);
		expect((await registry.callTool('fix_canvas_style', {})).isError).toBe(true);
	});

	it('needs its domain registered', () => {
		expect(() => createCanvasStyleToolProvider(createStyleResolver({ layers: [], domains: [] }), { getNodes: () => [], setNodes: () => {} })).toThrow(/no "canvas" domain/);
	});
});

describe('typography house style', () => {
	const FONTS: FontSummary[] = [
		{ family: 'Inter', category: 'sans-serif', weights: [400, 600, 700], styles: ['normal'] },
		{ family: 'Lora', category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] }
	] as FontSummary[];
	const picker = () => createFontPicker({ fonts: FONTS, value: { family: 'Lora', weight: 700, size: 15, lineHeight: 1.1, letterSpacing: 0.2 } });

	it('weights, sizes, line-height, letter-spacing and the brand fonts', async () => {
		const styles = resolver('typography', { weights: [400, 600], sizes: [12, 14, 16, 20], lineHeight: { min: 1.3, max: 1.7 }, letterSpacing: { max: 0.05 }, checks: ['weights', 'sizes', 'line-height', 'letter-spacing', 'fonts-allowed'] }, { fonts: { body: 'Inter' } });
		const report = await styles.check('typography', picker().getState().value as any);
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['weights', { field: 'weight', value: 600 }],
			['sizes', { field: 'size', value: 14 }],
			['line-height', { field: 'lineHeight', value: 1.3 }],
			['letter-spacing', { field: 'letterSpacing', value: 0.05 }],
			['fonts-allowed', { field: 'family' }]
		]);
		expect((await styles.resolve('typography')).profile.fonts).toEqual(['Inter']); // derived from the brand
	});

	it('check and fix through the tools; hidden when read-only', async () => {
		const model = picker();
		let readOnly: string | false = false;
		const styles = resolver('typography', { weights: [400, 600], sizes: [12, 14, 16, 20], lineHeight: { min: 1.3, max: 1.7 }, checks: ['weights', 'sizes', 'line-height', 'fonts-allowed'] }, { fonts: { body: 'Inter' } });
		const registry = new ToolRegistry();
		registry.register(createTypographyStyleToolProvider(model, styles, { namespace: '', readOnly: () => readOnly }));
		expect((await registry.callTool('check_typography_style', {})).structuredContent).toMatchObject({ ok: false });
		const fix = await registry.callTool('fix_typography_style', {});
		expect(fix.structuredContent).toMatchObject({ fixed: 4, left: [], selection: { family: 'Inter', weight: 600, size: 14, lineHeight: 1.3 } });
		expect((await registry.callTool('check_typography_style', {})).structuredContent).toMatchObject({ ok: true });
		readOnly = 'locked';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_typography_style']);
		expect((await registry.callTool('fix_typography_style', {})).isError).toBe(true);
	});
});
