import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, createStyleToolProvider, memoryStyleStore, removeStyleSkill, saveStyleSkill, styleStoreConformance, type StyleStore } from '../src/tools';
import { chartStyleDomain } from '../src/chart';

const md = (name: string, body = 'Use it.') => `---\nname: ${name}\ndescription: ${name} style.\n---\n\n${body}\n`;

const setup = () => {
	const org = memoryStyleStore({ 'acme/SKILL.md': md('acme'), 'acme/chart.json': JSON.stringify({ palette: ['#0b5fff'] }) });
	const user = memoryStyleStore();
	const document = memoryStyleStore();
	const styles = createStyleResolver({
		layers: [
			{ id: 'org', store: org, locked: true },
			{ id: 'user', store: user },
			{ id: 'document', store: document }
		],
		domains: [chartStyleDomain]
	});
	return { org, user, document, styles };
};

describe('saveStyleSkill', () => {
	it('saves to the most specific writable layer, checked as it will load', async () => {
		const { styles, document } = setup();
		const saved = await saveStyleSkill(styles, 'report', { 'SKILL.md': md('report'), 'chart.json': JSON.stringify({ palette: ['#ff6a00'] }) });
		expect(saved).toEqual({ name: 'report', layer: 'document', files: ['SKILL.md', 'chart.json'], created: true, domains: ['chart', 'brand'], profiles: { chart: { palette: ['#ff6a00'] } }, warnings: [] });
		expect(document.toJSON().files['report/chart.json']).toBe('{"palette":["#ff6a00"]}');
		// The org layer is locked and sets the palette, so the document's is ignored, and says so.
		const chart = await styles.resolve('chart');
		expect(chart.sources.palette).toBe('org');
		expect(chart.issues.map((i) => i.message)).toContain('"palette" is locked by the org layer, so this skill\'s value is ignored.');
	});

	it('merges over the layer copy unless replace, and keeps what it does not name', async () => {
		const { styles, user } = setup();
		await saveStyleSkill(styles, 'mine', { 'SKILL.md': md('mine'), 'chart.json': '{"palette":["#111111"]}', 'references/tone.md': 'Brief.' }, { layer: 'user' });
		const edited = await saveStyleSkill(styles, 'mine', { 'SKILL.md': md('mine', 'Even plainer.') }, { layer: 'user' });
		expect(edited).toMatchObject({ created: false, files: ['SKILL.md', 'chart.json', 'references/tone.md'] });
		const replaced = await saveStyleSkill(styles, 'mine', { 'SKILL.md': md('mine') }, { layer: 'user', replace: true });
		expect(replaced.files).toEqual(['SKILL.md']);
		expect(await user.files('mine')).toEqual(['SKILL.md']);
	});

	it('refuses, writing nothing, what would not load, read-only layers and names a locked layer holds', async () => {
		const { styles, user, document } = setup();
		await expect(saveStyleSkill(styles, 'bad', { 'SKILL.md': md('bad'), 'chart.json': '{"palette":[]}' })).rejects.toThrow(/^"bad" was not saved: chart\.json is left out: \/palette: Must have at least 1 items\./);
		await expect(saveStyleSkill(styles, 'nofm', { 'SKILL.md': 'No frontmatter.' })).rejects.toThrow(/SKILL\.md has no frontmatter/);
		await expect(saveStyleSkill(styles, 'acme', { 'SKILL.md': md('acme') }, { layer: 'user' })).rejects.toThrow(/The org layer locks "acme", so a copy in the user layer would be ignored/);
		await expect(saveStyleSkill(styles, 'x', { 'SKILL.md': md('x') }, { layer: 'org' })).resolves.toMatchObject({ layer: 'org' });
		const ro: StyleStore = { list: () => [], read: () => undefined, files: () => [] };
		const readOnly = createStyleResolver({ layers: [{ id: 'org', store: ro }], domains: [] });
		await expect(saveStyleSkill(readOnly, 'x', { 'SKILL.md': md('x') })).rejects.toThrow(/Every style store here is read-only/);
		await expect(saveStyleSkill(styles, 'x', { 'SKILL.md': md('x') }, { layer: 'mars' })).rejects.toThrow(/There is no layer "mars"/);
		await expect(saveStyleSkill(styles, 'Bad Name', { 'SKILL.md': md('x') })).rejects.toThrow(/not a valid skill name/);
		expect(user.toJSON().files).toEqual({});
		expect(Object.keys(document.toJSON().files)).toEqual([]);
	});
});

describe('removeStyleSkill', () => {
	it('removes the most specific writable copy and says which layer still provides it', async () => {
		const { styles } = setup();
		await saveStyleSkill(styles, 'mine', { 'SKILL.md': md('mine') }, { layer: 'user' });
		await saveStyleSkill(styles, 'mine', { 'SKILL.md': md('mine', 'Document copy.') });
		expect(await removeStyleSkill(styles, 'mine')).toEqual({ name: 'mine', layer: 'document', stillProvidedBy: 'user' });
		expect(await removeStyleSkill(styles, 'mine')).toEqual({ name: 'mine', layer: 'user' });
		await expect(removeStyleSkill(styles, 'mine')).rejects.toThrow(/There is no house-style skill "mine"/);
		await expect(removeStyleSkill(styles, 'acme', { layer: 'user' })).rejects.toThrow(/The user layer has no "acme" to remove/);
	});

	it('points at state for skills in read-only layers', async () => {
		const ro = memoryStyleStore({ 'acme/SKILL.md': md('acme') });
		const styles = createStyleResolver({ layers: [{ id: 'org', store: { list: ro.list, read: ro.read, files: ro.files } }], domains: [] });
		await expect(removeStyleSkill(styles, 'acme')).rejects.toThrow(/only in read-only layers \(org\); switch it off with its state instead/);
	});
});

describe('a document layer', () => {
	it('round-trips through toJSON, so a file carries its own style', async () => {
		const { styles, document } = setup();
		await saveStyleSkill(styles, 'report', { 'SKILL.md': md('report'), 'chart.json': JSON.stringify({ palette: ['#ff6a00'] }) });
		document.setState('report', { order: 1 });
		const saved = JSON.parse(JSON.stringify(document.toJSON()));
		const reopened = memoryStyleStore(saved.files, saved.state);
		expect(reopened.toJSON()).toEqual(document.toJSON());
		const again = createStyleResolver({ layers: [{ id: 'document', store: reopened }], domains: [chartStyleDomain] });
		expect((await again.resolve('chart')).profile.palette).toEqual(['#ff6a00']);
	});

	it('the memory store still passes the store conformance cases', async () => {
		for (const c of styleStoreConformance(({ files, state }) => memoryStyleStore(files, state))) await c.run();
	});
});

describe('agent path', () => {
	it('save_style and remove_style, then reading back', async () => {
		const { styles } = setup();
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles));
		const saved = await registry.callTool('save_style', { name: 'report', files: { 'SKILL.md': md('report'), 'chart.json': '{"palette":["#ff6a00"]}' }, layer: 'user' });
		expect(saved.isError).toBeFalsy();
		expect(saved.structuredContent).toMatchObject({ layer: 'user', created: true });
		expect((await registry.callTool('list_styles', {})).structuredContent).toMatchObject({ skills: [{ name: 'acme' }, { name: 'report', layer: 'user' }] });
		const bad = await registry.callTool('save_style', { name: 'bad', files: { 'SKILL.md': md('bad'), 'chart.json': '{' } });
		expect(bad.isError).toBe(true);
		expect((bad.content[0] as any).text).toMatch(/"bad" was not saved: chart\.json is not valid JSON/);
		expect((await registry.callTool('save_style', { name: 'x', files: {}, colour: 1 })).isError).toBe(true);
		expect((await registry.callTool('remove_style', { name: 'report' })).structuredContent).toEqual({ name: 'report', layer: 'user' });
		expect((await registry.callTool('remove_style', { name: 'report' })).isError).toBe(true);
	});

	it('offers no write tools when every layer is read-only', () => {
		const ro = memoryStyleStore();
		const styles = createStyleResolver({ layers: [{ id: 'org', store: { list: ro.list, read: ro.read, files: ro.files } }], domains: [] });
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles, { namespace: '' }));
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('get_style');
		expect(names).not.toContain('save_style');
		expect(names).not.toContain('remove_style');
	});
});
