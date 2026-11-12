import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, createStyleToolProvider, memoryStyleStore, type StyleStore } from '../src/tools';
import { chartStyleDomain } from '../src/chart';

const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: The ${name} look.\n${extra}---\n\nUse the ${name} look.\n`;
const look = (name: string, palette: string[]) => ({
	[`${name}/SKILL.md`]: skill(name, 'group: look\n'),
	[`${name}/chart.json`]: JSON.stringify({ palette })
});

const setup = (orgState: Record<string, any> = {}, userState: Record<string, any> = {}) => {
	const org = memoryStyleStore({ ...look('bold', ['#ff0000']), ...look('quiet', ['#888888']), 'base/SKILL.md': skill('base') }, orgState);
	const user = memoryStyleStore({}, userState);
	const styles = createStyleResolver({ layers: [{ id: 'org', store: org }, { id: 'user', store: user }], domains: [chartStyleDomain] });
	return { org, user, styles };
};

describe('one-of-a-kind groups', () => {
	it('applies only the first switched-on skill of a group, and lists the choice', async () => {
		const { styles } = setup();
		const chart = await styles.resolve('chart');
		expect(chart.skills.map((s) => s.name)).toEqual(['base', 'bold']);
		expect(chart.profile.palette).toEqual(['#ff0000']);
		expect(await styles.choices()).toEqual([
			{ group: 'look', chosen: 'bold', options: [expect.objectContaining({ name: 'bold', chosen: true, group: 'look' }), expect.objectContaining({ name: 'quiet', chosen: false })] }
		]);
		expect((await styles.chosen('look'))?.name).toBe('bold');
		expect(await styles.chosen('theme')).toBeUndefined();
		expect((await styles.list()).find((s) => s.name === 'base')).not.toHaveProperty('chosen');
	});

	it('choose switches one on and its rivals off in the most specific writable layer', async () => {
		const { styles, user, org } = setup();
		const result = await styles.choose('quiet');
		expect(result).toEqual({ group: 'look', chosen: 'quiet', layer: 'user', switchedOff: ['bold'] });
		expect(await user.list()).toEqual([{ name: 'bold', enabled: false }]);
		expect(await org.list()).toEqual([{ name: 'base' }, { name: 'bold' }, { name: 'quiet' }]);
		expect((await styles.resolve('chart')).profile.palette).toEqual(['#888888']);
		// Choosing again changes nothing.
		expect((await styles.choose('quiet')).switchedOff).toEqual([]);
		expect(await user.list()).toEqual([{ name: 'bold', enabled: false }]);
		// And back: quiet is switched off, bold's own off state is replaced.
		await styles.choose('bold');
		expect(await user.list()).toEqual([
			{ name: 'bold', enabled: true },
			{ name: 'quiet', enabled: false }
		]);
	});

	it('takes the group from state over frontmatter', async () => {
		const { styles } = setup({ base: { group: 'look', order: -1 } });
		expect((await styles.chosen('look'))?.name).toBe('base');
		expect((await styles.resolve('chart')).profile).toEqual({});
	});

	it('refuses an unknown or ungrouped skill, a read-only layer and a required rival, writing nothing', async () => {
		const { styles, user } = setup();
		await expect(styles.choose('nope')).rejects.toThrow(/There is no house-style skill "nope"; the skills are "base", "bold", "quiet"\./);
		await expect(styles.choose('base')).rejects.toThrow(/"base" is not in a one-of-a-kind group.*The groups are "look"\./);
		await expect(styles.choose('quiet', { layer: 'mars' })).rejects.toThrow(/There is no layer "mars"/);

		const readOnly: StyleStore = { list: () => [], read: () => undefined, files: () => [] };
		const org = memoryStyleStore({ ...look('bold', ['#f00']), ...look('quiet', ['#888']) });
		const locked = createStyleResolver({ layers: [{ id: 'org', store: org, required: true }, { id: 'user', store: user }], domains: [chartStyleDomain] });
		await expect(locked.choose('quiet')).rejects.toThrow(/The org layer requires "bold", so "quiet" cannot replace it in the "look" group\./);
		expect(await user.list()).toEqual([]);
		const none = createStyleResolver({ layers: [{ id: 'org', store: { ...readOnly, list: org.list, read: org.read, files: org.files } }], domains: [chartStyleDomain] });
		await expect(none.choose('quiet')).rejects.toThrow(/every style store is read-only/);
	});

	it('says when a later layer still keeps another skill first', async () => {
		const { styles } = setup({}, { quiet: { enabled: false } });
		const result = await styles.choose('quiet', { layer: 'org' });
		expect(result.note).toMatch(/A later layer's state still puts "\(none\)" first in "look"/);
	});
});

describe('scope', () => {
	const scoped = () => {
		const org = memoryStyleStore(
			{ ...look('report-look', ['#111111']), ...look('slides-look', ['#222222']), 'everywhere/SKILL.md': skill('everywhere') },
			{ 'report-look': { scope: ['report'] }, 'slides-look': { scope: ['slides'] } }
		);
		return createStyleResolver({ layers: [{ id: 'org', store: org }], domains: [chartStyleDomain] });
	};

	it('applies scoped skills only in their scope', async () => {
		const styles = scoped();
		expect((await styles.resolve('chart')).skills.map((s) => s.name)).toEqual(['everywhere']);
		expect((await styles.resolve('chart', { scope: 'report' })).skills.map((s) => s.name)).toEqual(['everywhere', 'report-look']);
		expect((await styles.resolve('chart', { scope: 'slides' })).profile.palette).toEqual(['#222222']);
		expect((await styles.list({ scope: 'report' })).map((s) => s.name)).toEqual(['everywhere', 'report-look']);
		expect((await styles.list()).map((s) => [s.name, s.scope])).toEqual([
			['everywhere', undefined],
			['report-look', ['report']],
			['slides-look', ['slides']]
		]);
	});

	it('holds one choice per scope', async () => {
		const styles = scoped();
		expect((await styles.chosen('look', { scope: 'report' }))?.name).toBe('report-look');
		expect((await styles.chosen('look', { scope: 'slides' }))?.name).toBe('slides-look');
		expect(await styles.chosen('look')).toBeUndefined();
		await expect(styles.choose('report-look', { scope: 'slides' })).rejects.toThrow(/does not apply in scope "slides"; its scopes are "report"/);
	});
});

describe('agent path', () => {
	const registry = (scope?: string) => {
		const { styles, user } = setup();
		const r = new ToolRegistry();
		r.register(createStyleToolProvider(styles, scope ? { scope } : {}));
		return { r, user, styles };
	};

	it('list_style_choices and choose_style', async () => {
		const { r, user } = registry();
		const list = await r.callTool('list_style_choices', {});
		expect(list.structuredContent).toMatchObject({ groups: [{ group: 'look', chosen: 'bold' }], writableLayers: ['org', 'user'] });
		const chosen = await r.callTool('choose_style', { name: 'quiet' });
		expect(chosen.isError).toBeFalsy();
		expect(chosen.structuredContent).toEqual({ group: 'look', chosen: 'quiet', layer: 'user', switchedOff: ['bold'] });
		expect(await user.list()).toEqual([{ name: 'bold', enabled: false }]);
		const style = await r.callTool('get_style', { domain: 'chart' });
		expect(style.structuredContent).toMatchObject({ profile: { palette: ['#888888'] } });
	});

	it('choose_style refuses bad arguments with a reason', async () => {
		const { r } = registry();
		const ungrouped = await r.callTool('choose_style', { name: 'base' });
		expect(ungrouped.isError).toBe(true);
		expect((ungrouped.content[0] as any).text).toMatch(/not in a one-of-a-kind group/);
		expect((await r.callTool('choose_style', { name: 'bold', layer: 'mars' })).isError).toBe(true);
		expect((await r.callTool('choose_style', {})).isError).toBe(true);
	});

	it('uses the scope the host gives the provider', async () => {
		const org = memoryStyleStore({ ...look('report-look', ['#111111']) }, { 'report-look': { scope: ['report'] } });
		const styles = createStyleResolver({ layers: [{ id: 'org', store: org }], domains: [chartStyleDomain] });
		const inReport = new ToolRegistry();
		inReport.register(createStyleToolProvider(styles, { scope: 'report' }));
		expect((await inReport.callTool('get_style', { domain: 'chart' })).structuredContent).toMatchObject({ profile: { palette: ['#111111'] } });
		const elsewhere = new ToolRegistry();
		elsewhere.register(createStyleToolProvider(styles));
		expect((await elsewhere.callTool('get_style', { domain: 'chart' })).structuredContent).toMatchObject({ profile: {} });
		expect((await inReport.callTool('list_style_choices', {})).structuredContent).toMatchObject({ groups: [{ group: 'look', chosen: 'report-look' }] });
	});
});
