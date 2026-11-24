// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIAGRAM_UI_RENDER_VERSIONS, diagramReadableFill, diagramUiComponents, type DiagramUiComponent } from '../src/canvas';
import { contrastRatio } from '../src/color/contrast';
import { parseColor } from '../src/color/parse';
import { formatHex } from '../src/color/format';
import { parseMermaid } from '../src/diagram/document';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

const descriptorSchema = JSON.parse(readFileSync(join(__dirname, 'fixtures/ui-descriptor.schema.json'), 'utf8')) as JsonSchema;
const fallbackSchema = JSON.parse(readFileSync(join(__dirname, 'fixtures/ui-fallback.schema.json'), 'utf8')) as JsonSchema;
const tablePropsSchema = JSON.parse(readFileSync(join(__dirname, 'fixtures/ui-table-props.schema.json'), 'utf8')) as JsonSchema;
const byId = (id: string): DiagramUiComponent => diagramUiComponents().find((c) => c.id === id)!;

const parseSvg = (svg: string): SVGSVGElement => {
	const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
	expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
	expect(doc.documentElement.tagName).toBe('svg');
	return doc.documentElement as unknown as SVGSVGElement;
};

describe('diagramUiComponents', () => {
	it('lists the diagram families as data visuals with valid descriptors', () => {
		const list = diagramUiComponents();
		expect(list.map((c) => c.id)).toEqual(['flow', 'timeline', 'mindmap']);
		for (const c of list) {
			expect(c.descriptor).toMatchObject({ implements: c.id, group: 'data-visual', platforms: ['html-page'], swiftReady: false });
			const json = JSON.parse(JSON.stringify(c.descriptor));
			expect(json).toEqual(c.descriptor);
			expect(validateJsonSchema(json, descriptorSchema)).toEqual([]);
			const contract = c.descriptor.contract!;
			expect(contract.props).toMatchObject({ type: 'object', additionalProperties: false });
			expect(validateJsonSchema(c.descriptor.example, contract.props as JsonSchema)).toEqual([]);
			expect(contract.a11y).toEqual({ role: 'img', keyboard: {}, labelFrom: 'content' });
			expect(contract.motion).toBe(false);
			expect(Object.keys(c.colorRoleUse).sort()).toEqual([...contract.colorRoles!].sort());
			for (const mode of ['light', 'dark'] as const) expect(Object.keys(c.defaultColors[mode]).sort()).toEqual([...contract.colorRoles!].sort());
		}
		expect(Object.keys(DIAGRAM_UI_RENDER_VERSIONS)).toEqual(['flow', 'timeline', 'mindmap']);
	});

	it('writes Mermaid that parses as an editable diagram of the family', () => {
		for (const c of diagramUiComponents()) {
			const doc = parseMermaid(c.toMermaid(c.descriptor.example));
			expect(doc.tier).toBe('editable');
		}
		const flow = byId('flow').toMermaid({ steps: [{ label: 'A "quoted" step' }, { label: 'Line\nbreak' }] });
		expect(flow).toContain('s0["A #quot;quoted#quot; step"]');
		expect(flow).toContain('s1["Line break"]');
		expect(flow).toContain('s0 --> s1');
		const linked = byId('flow').toMermaid({ steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], links: [{ from: 'a', to: 'c', label: 'skip' }], direction: 'TD' });
		expect(linked).toMatch(/^flowchart TD/);
		expect(linked).toContain('s0 -->|"skip"| s2');
		expect(linked).not.toContain('s0 --> s1');
		expect(byId('timeline').toMermaid({ periods: [{ label: 'Q1: plan', events: ['Kick-off: day 1'] }] })).toContain('Q1∶ plan : Kick-off∶ day 1');
	});

	it('renders each family at the size asked, light and dark, with an accessible name', () => {
		for (const c of diagramUiComponents()) {
			for (const theme of ['light', 'dark'] as const) {
				const svg = c.render(c.descriptor.example, { width: 480, height: 300, theme });
				const root = parseSvg(svg);
				expect(root.getAttribute('width')).toBe('480');
				expect(root.getAttribute('height')).toBe('300');
				expect(root.getAttribute('role')).toBe('img');
				expect(svg.slice(0, svg.indexOf('>')).match(/\srole=/g)).toHaveLength(1);
				expect(root.getAttribute('viewBox')).toBeTruthy();
				expect(svg).toContain(`fill="${c.defaultColors[theme].surface}"`);
				const named = root.getAttribute('aria-label') ?? root.querySelector('title')?.textContent;
				expect(named).toBeTruthy();
			}
			// The same input draws the same SVG.
			expect(c.render(c.descriptor.example, { width: 400, height: 260 })).toBe(c.render(c.descriptor.example, { width: 400, height: 260 }));
		}
		const flow = byId('flow').render({ steps: [{ label: 'Sign up' }, { label: 'Pay' }] }, { width: 400, height: 120 });
		expect(flow).toContain('Sign up');
		expect(flow).toContain('Pay');
	});

	it('takes role colours, accent first', () => {
		const svg = byId('mindmap').render(byId('mindmap').descriptor.example, { width: 480, height: 300, colors: { accent: '#ff00aa', surface: '#fafafa', border: '#222222' } });
		expect(svg).toContain('stroke="#ff00aa"');
		expect(svg).toContain('fill="#fafafa"');
		// The root takes the ink role (border only outlines), its label the surface.
		expect(svg).not.toMatch(/<circle[^>]*fill="#222222"[^>]*data-target="root"/);
		const flow = byId('flow').render(byId('flow').descriptor.example, { width: 480, height: 120, colors: { ink: '#111111', 'surface-raised': '#eeeeee', 'ink-muted': '#777777' } });
		expect(flow).toContain('#111111');
		expect(flow).toContain('fill="#eeeeee"');
		expect(flow).toContain('#777777');
	});

	it('keeps every label at WCAG AA on its box, whatever the brand colours', () => {
		// Shapes and the labels drawn over them, paired by data-target (the box of a period, branch or root).
		const pairs = (svg: string) => {
			const out: { fill: string; text: string; label: string }[] = [];
			const boxes = new Map<string, string>();
			for (const m of svg.matchAll(/<(rect|circle|path|text)\b([^>]*)>([^<]*)/g)) {
				const fill = /\sfill="(#[0-9a-fA-F]{3,8})"/.exec(m[2]!)?.[1];
				const target = /\sdata-target="([^"]+)"/.exec(m[2]!)?.[1];
				if (!fill || !target) continue;
				if (m[1] !== 'text') {
					// A translucent shape (a shade over a box) composites over the box under it.
					const opacity = Number(/\sopacity="([\d.]+)"/.exec(m[2]!)?.[1] ?? 1);
					const top = parseColor(fill)!;
					const under = parseColor(boxes.get(target) ?? fill)!;
					boxes.set(target, opacity < 1 ? formatHex({ r: top.r * opacity + under.r * (1 - opacity), g: top.g * opacity + under.g * (1 - opacity), b: top.b * opacity + under.b * (1 - opacity), a: 1 }) : fill);
				} else if (boxes.has(target) && m[3]!.trim()) out.push({ fill: boxes.get(target)!, text: fill, label: m[3]!.trim() });
			}
			return out;
		};
		// Hairline borders and near-black or near-white primaries, as design systems define them.
		const brands = [
			{ theme: 'light' as const, colors: { surface: '#ffffff', 'surface-raised': '#fafafa', ink: '#18181b', 'ink-muted': '#52525b', border: '#d4d4d8', accent: '#18181b' } },
			{ theme: 'dark' as const, colors: { surface: '#09090b', 'surface-raised': '#18181b', ink: '#fafafa', 'ink-muted': '#a1a1aa', border: '#3f3f46', accent: '#fafafa' } },
			{ theme: 'light' as const, colors: { accent: '#1e3a8a' } },
			{ theme: 'dark' as const, colors: { accent: '#7c3aed', border: '#27272a' } }
		];
		for (const id of ['timeline', 'mindmap'] as const) {
			const c = byId(id);
			for (const { theme, colors } of brands) {
				const found = pairs(c.render(c.descriptor.example, { width: 560, height: 320, theme, colors }));
				expect(found.length).toBeGreaterThan(3);
				for (const p of found) expect(contrastRatio(parseColor(p.text)!, parseColor(p.fill)!), `${id} ${theme} ${p.label} ${p.text} on ${p.fill}`).toBeGreaterThanOrEqual(4.5);
			}
		}
		expect(diagramReadableFill('#ffad5c', '#0f172a')).toBe('#ffad5c');
		const shifted = diagramReadableFill('#18181b', '#0f172a');
		expect(contrastRatio(parseColor('#0f172a')!, parseColor(shifted)!)).toBeGreaterThanOrEqual(4.5);
	});

	it('refuses bad data and sizes with a message', () => {
		const flow = byId('flow');
		expect(() => flow.render({ steps: [] }, { width: 300, height: 100 })).toThrow(/flow: invalid data/);
		expect(() => flow.render({ steps: [{ label: 'A' }], links: [{ from: '1', to: '9' }] }, { width: 300, height: 100 })).toThrow(/names a step that does not exist/);
		expect(() => flow.render(flow.descriptor.example, { width: 0, height: 100 })).toThrow(/width must be/);
		expect(() => byId('mindmap').render({ root: 'R', branches: [{ label: 'a', children: [{ label: 'b', children: [{ label: 'c', children: [] }] }] }] }, { width: 300, height: 200 })).toThrow(/invalid data/);
		expect(() => byId('timeline').toMermaid({ periods: [{ label: '2020' }] })).toThrow(/timeline: invalid data/);
	});

	it('falls back to a table that validates against @pixerate/schemas', () => {
		for (const c of diagramUiComponents()) {
			expect(c.descriptor.fallback).toBe('table');
			const out = c.fallback(c.descriptor.example);
			expect(validateJsonSchema(out, fallbackSchema)).toEqual([]);
			expect(validateJsonSchema(out.props, tablePropsSchema)).toEqual([]);
		}
		expect(byId('flow').fallback(byId('flow').descriptor.example).props).toEqual({
			columns: ['Step', 'Leads to'],
			rows: [['Sign up', 'Verify email'], ['Verify email', 'Pick a plan'], ['Pick a plan', 'Start trial'], ['Start trial', '']],
			rowHeaders: true
		});
		expect(byId('flow').fallback({ title: 'Review', steps: [{ id: 'a', label: 'Draft' }, { id: 'b', label: 'Ship' }, { id: 'c', label: 'Fix' }], links: [{ from: 'a', to: 'b', label: 'ok' }, { from: 'a', to: 'c', label: 'no' }, { from: 'c', to: 'a' }] }).props).toEqual({
			caption: 'Review',
			columns: ['Step', 'Leads to'],
			rows: [['Draft', 'Ship (ok), Fix (no)'], ['Ship', ''], ['Fix', 'Draft']],
			rowHeaders: true
		});
		expect(byId('timeline').fallback(byId('timeline').descriptor.example).props).toEqual({
			caption: 'Product history',
			columns: ['Period', 'Events'],
			rows: [['2021', 'Prototype; First customer'], ['2022', 'Series A'], ['2023', 'Mobile app; 1M users']],
			rowHeaders: true
		});
		expect(byId('mindmap').fallback({ root: 'R', branches: [{ label: 'a', children: [{ label: 'b', children: [{ label: 'c' }] }, { label: 'd' }] }, { label: 'e' }] }).props).toEqual({
			caption: 'R',
			columns: ['Branch', 'Topic', 'Detail'],
			rows: [['a', 'b', 'c'], ['a', 'd', null], ['e', null, null]],
			rowHeaders: true
		});
		expect(() => byId('flow').fallback({ steps: [{ label: 'A' }], links: [{ from: '1', to: '9' }] })).toThrow(/names a step that does not exist/);
		expect(() => byId('timeline').fallback({ periods: [] })).toThrow(/timeline: invalid data/);
	});

	it('keeps content hashes stable and returns copies', () => {
		const a = diagramUiComponents();
		const b = diagramUiComponents();
		expect(a.map((c) => c.descriptor.contentHash)).toEqual(b.map((c) => c.descriptor.contentHash));
		expect(new Set(a.map((c) => c.descriptor.contentHash)).size).toBe(3);
		(a[0]!.descriptor.example as Record<string, unknown>).title = 'changed';
		expect(diagramUiComponents()[0]!.descriptor.example).not.toHaveProperty('title');
	});

	it.skipIf(!process.env.DIAGRAM_UI_SHOTS)('writes renders for a look', () => {
		const dir = process.env.DIAGRAM_UI_SHOTS!;
		mkdirSync(dir, { recursive: true });
		let html = '<body style="margin:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#888">';
		for (const c of diagramUiComponents()) for (const theme of ['light', 'dark'] as const) html += `<div>${c.render(c.descriptor.example, { width: 560, height: 320, theme })}</div>`;
		writeFileSync(join(dir, 'diagram-ui.html'), html + '</body>');
	});
});
