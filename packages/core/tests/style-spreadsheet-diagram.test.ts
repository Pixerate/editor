import { describe, it, expect } from 'vitest';
import { ToolRegistry, applyTextCase, createStyleResolver, createStyleToolProvider, memoryStyleStore } from '../src/tools';
import { SpreadsheetController, createSpreadsheetStyleToolProvider, spreadsheetStyleDomain, spreadsheetStyleSurface } from '../src/spreadsheet';
import { DiagramController, createDiagramStyleToolProvider, diagramStyleDomain, diagramStyleSurface } from '../src/diagram';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [spreadsheetStyleDomain, diagramStyleDomain]
	});

const sheet = (rows: (string | null)[][]) => {
	const columns = Math.max(...rows.map((r) => r.length));
	const s = new SpreadsheetController({
		document: {
			columns: Array.from({ length: columns }, (_, i) => ({ id: `c${i}`, key: String.fromCharCode(65 + i), title: String.fromCharCode(65 + i), type: 'freeform' as const })),
			rows: rows.map((_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
		} as any
	});
	rows.forEach((row, r) => row.forEach((v, c) => v !== null && s.setCellValue(`r${r}`, `c${c}`, v)));
	return s;
};

describe('applyTextCase', () => {
	it('is shared by the rich-text, spreadsheet and diagram styles', () => {
		expect(applyTextCase('Total Revenue USD', 'sentence')).toBe('Total revenue USD');
		expect(applyTextCase('send to the API', 'title')).toBe('Send to the API');
	});
});

describe('spreadsheet house style', () => {
	const data = () => sheet([['Region Name', 'Total Revenue', 'Growth'], ['North', '$1,200.50', '10%'], ['South', '$900', '5%']]);

	it('header-case, number-formats and freeze-header, with targets in A1 notation', async () => {
		const s = data();
		const styles = resolver('spreadsheet', { headerCase: 'sentence', numberFormats: { currency: '"$"#,##0.00', percentage: '0.0%' }, freezeHeader: true, checks: ['header-case', 'number-formats', 'freeze-header'] });
		const report = await styles.check('spreadsheet', s.document);
		expect(report.ran).toEqual(['header-case', 'number-formats', 'freeze-header']);
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['header-case', { cell: 'A1', value: 'Region name' }],
			['header-case', { cell: 'B1', value: 'Total revenue' }],
			['number-formats', { cell: 'C2', numberFormat: '0.0%' }],
			['number-formats', { cell: 'B3', numberFormat: '"$"#,##0.00' }],
			['number-formats', { cell: 'C3', numberFormat: '0.0%' }],
			['freeze-header', { sheet: true }]
		]);
		// "$1,200.50" got "$"#,##0.00 automatically, which is the house format: no finding for B2.
		// "$900" got "$"#,##0, which is not.
		expect(s.getCell('r1', 'c1').numberFormat).toBe('"$"#,##0.00');
	});

	it('conditional format colours are the surface for the brand checks', async () => {
		const s = data();
		s.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', values: ['1000'], ranges: [{ startRow: 1, startCol: 1, endRow: 2, endCol: 1 }], style: { fill: '#9933cc', color: '#ffffff' } } as any);
		const surface = spreadsheetStyleSurface(s.document);
		expect(surface.colors?.map((c) => [c.use, c.color])).toEqual([
			['background', '#9933cc'],
			['text', '#ffffff']
		]);
		const styles = resolver('spreadsheet', { checks: ['palette-only'] }, { colors: { primary: '#0b5fff' } });
		const report = await styles.check('spreadsheet', s.document);
		expect(report.findings).toEqual([expect.objectContaining({ check: 'palette-only', target: { rule: expect.any(String) } })]);
	});

	it('check and fix through the tools, as one undo step; hidden when read-only', async () => {
		const s = data();
		const styles = resolver('spreadsheet', { headerCase: 'sentence', numberFormats: { percentage: '0.0%' }, freezeHeader: true, checks: ['header-case', 'number-formats', 'freeze-header'] });
		let readOnly: string | false = false;
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles));
		registry.register(createSpreadsheetStyleToolProvider(s, styles, { namespace: '', readOnly: () => readOnly }));
		const check = await registry.callTool('check_spreadsheet_style', {});
		expect(check.structuredContent).toMatchObject({ ok: false, fixable: 5 });
		const before = JSON.stringify(s.document.cells);
		const fix = await registry.callTool('fix_spreadsheet_style', {});
		expect(fix.isError).toBeFalsy();
		expect(fix.structuredContent).toEqual({ fixed: 5, left: [] });
		expect(s.getCell('r0', 'c0').raw).toBe('Region name');
		expect(s.getCell('r2', 'c2').numberFormat).toBe('0.0%');
		expect(s.document.table?.frozenRowCount).toBe(1);
		expect((await registry.callTool('check_spreadsheet_style', {})).structuredContent).toMatchObject({ ok: true });
		s.undo();
		expect(JSON.stringify(s.document.cells)).toBe(before);
		readOnly = 'The budget is locked.';
		expect(registry.listTools().tools.map((t) => t.name)).not.toContain('fix_spreadsheet_style');
		expect((await registry.callTool('fix_spreadsheet_style', {})).isError).toBe(true);
		expect((await registry.callTool('check_spreadsheet_style', { x: 1 })).isError).toBe(true);
	});

	it('needs its domain registered, and says when no style applies', async () => {
		const s = data();
		expect(() => createSpreadsheetStyleToolProvider(s, createStyleResolver({ layers: [], domains: [] }))).toThrow(/no "spreadsheet" domain/);
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetStyleToolProvider(s, createStyleResolver({ layers: [], domains: [spreadsheetStyleDomain] }), { namespace: '' }));
		expect((await registry.callTool('check_spreadsheet_style', {})).structuredContent).toMatchObject({ ok: true, note: 'No house style applies to spreadsheets.' });
	});
});

describe('diagram house style', () => {
	const diagram = (source: string) => {
		const c = new DiagramController();
		c.load(source);
		return c;
	};
	const SOURCE = 'flowchart TB\n  A[Collect Customer Feedback] --> B{Is It Urgent}\n  B -->|Yes Please| C[(Store)]\n  B --> D>Flag]\n  style A fill:#9933cc,color:#ffffff\n';

	it('direction, label-case, label-length, max-nodes and allowed-shapes', async () => {
		const c = diagram(SOURCE);
		const styles = resolver('diagram', { directions: ['LR'], labelCase: 'sentence', maxLabelLength: 20, maxNodes: 3, shapes: ['rect', 'diam', 'cyl'], checks: ['direction', 'label-case', 'label-length', 'max-nodes', 'allowed-shapes'] });
		const report = await styles.check('diagram', c.getDocument().graph);
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['direction', { diagram: true, direction: 'LR' }],
			['label-case', { node: 'A', label: 'Collect customer feedback' }],
			['label-case', { node: 'B', label: 'Is it urgent' }],
			['label-case', { edge: expect.any(String), label: 'Yes please' }],
			['label-length', { node: 'A' }],
			['max-nodes', { diagram: true }],
			['allowed-shapes', { node: 'D' }]
		]);
	});

	it('node styles are the surface for the brand checks', async () => {
		const c = diagram(SOURCE);
		expect(diagramStyleSurface(c.getDocument().graph).colors?.map((x) => [x.use, x.color, (x as any).background])).toEqual([
			['background', '#9933cc', undefined],
			['text', '#ffffff', '#9933cc']
		]);
		const styles = resolver('diagram', { checks: ['palette-only'] }, { colors: { primary: '#0b5fff' } });
		expect((await styles.check('diagram', c.getDocument().graph)).findings).toEqual([expect.objectContaining({ check: 'palette-only', target: { node: 'A' } })]);
	});

	it('check and fix through the tools, as one undo step; hidden when read-only', async () => {
		const c = diagram(SOURCE);
		const styles = resolver('diagram', { directions: ['LR'], labelCase: 'sentence', shapes: ['rect', 'diam', 'cyl'], checks: ['direction', 'label-case', 'allowed-shapes'] });
		const registry = new ToolRegistry();
		registry.register(createDiagramStyleToolProvider(c, styles, { namespace: '' }));
		expect((await registry.callTool('check_diagram_style', {})).structuredContent).toMatchObject({ ok: false, fixable: 4 });
		const source = c.getSource();
		const fix = await registry.callTool('fix_diagram_style', {});
		expect(fix.structuredContent).toMatchObject({ fixed: 4, left: [expect.objectContaining({ check: 'allowed-shapes' })] });
		expect(c.getDocument().graph.direction).toBe('LR');
		expect(c.getDocument().graph.nodes.find((n) => n.id === 'A')?.label).toBe('Collect customer feedback');
		c.undo();
		expect(c.getSource()).toBe(source);
		c.setReadOnly(true);
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_diagram_style']);
		expect((await registry.callTool('fix_diagram_style', {})).isError).toBe(true);
	});
});
