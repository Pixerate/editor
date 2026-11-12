import { describe, it, expect } from 'vitest';
import {
	MAX_STYLE_INHERITANCE_DEPTH,
	ToolRegistry,
	checkStyleSkill,
	createStyleResolver,
	createStyleToolProvider,
	memoryStyleStore,
	removeStyleSkill,
	saveStyleSkill,
	scaffoldStyleSkill,
	styleProfileSchema,
	type StyleDomain
} from '../src/tools';

/** A small domain whose profile format is at version 3. */
const scene: StyleDomain = {
	id: 'scene',
	title: 'Scenes',
	description: 'A test domain.',
	profileSchema: {
		type: 'object',
		properties: {
			palette: { type: 'object', properties: { sky: { type: 'string' }, ground: { type: 'string' } }, additionalProperties: false },
			light: { type: 'object', properties: { intensity: { type: 'number', maximum: 4 } }, required: ['intensity'], additionalProperties: false },
			fonts: { type: 'array', items: { type: 'string' } },
			title: { type: 'string' }
		},
		required: ['palette'],
		additionalProperties: false
	},
	checks: [],
	example: { palette: { sky: '#88ccff', ground: '#eeeeee' } },
	profileVersion: 3,
	migrateProfile(profile, from, { partial }) {
		if (from === 1) {
			const { sky, ground, ...rest } = profile as { sky?: string; ground?: string };
			return { ...rest, palette: { ...(sky ? { sky } : {}), ...(ground ? { ground } : {}) } };
		}
		if (from === 2) return partial ? profile : { light: { intensity: 1 }, ...profile };
		throw new Error(`no step from ${from}`);
	}
};

const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} look.\n${extra}---\n\nPrefer ${name}.\n`;

describe('house style: extends', () => {
	const paper = { 'paper/SKILL.md': skill('paper'), 'paper/scene.json': JSON.stringify({ version: 3, palette: { sky: '#ffffff', ground: '#eeeeee' }, light: { intensity: 1 }, fonts: ['Inter', 'Georgia'], title: 'Paper' }) };

	it('a partial child merges over its base: objects field by field, lists replace; sources name the base', async () => {
		const styles = createStyleResolver({
			layers: [
				{ id: 'org', store: memoryStyleStore(paper) },
				{ id: 'user', store: memoryStyleStore({ 'night/SKILL.md': skill('night', 'extends: paper\n'), 'night/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000000' }, fonts: ['Inter'] }) }, { paper: { enabled: false } }) }
			],
			domains: [scene]
		});
		const night = (await styles.list()).find((s) => s.name === 'night')!;
		expect(night).toMatchObject({ inherits: ['paper'], profiles: ['scene'], issues: [] });
		const style = await styles.resolve('scene');
		expect(style.profile).toEqual({ palette: { sky: '#000000', ground: '#eeeeee' }, light: { intensity: 1 }, fonts: ['Inter'], title: 'Paper' });
		expect(style.sources).toEqual({ 'palette.sky': 'user', 'palette.ground': 'user (from paper)', 'light.intensity': 'user (from paper)', fonts: 'user', title: 'user (from paper)' });
		// The switched-off base still serves as a base, and its prose does not apply.
		expect(style.skills.map((s) => [s.name, s.inherits])).toEqual([['night', ['paper']]]);
	});

	it('the base is the copy in use, so overriding it in a later layer changes the children; chains resolve to the farthest base', async () => {
		const styles = createStyleResolver({
			layers: [
				{ id: 'org', store: memoryStyleStore({ ...paper, 'dusk/SKILL.md': skill('dusk', 'extends: night\n'), 'dusk/scene.json': JSON.stringify({ version: 3, title: 'Dusk' }), 'night/SKILL.md': skill('night', 'extends: paper\n'), 'night/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000000' } }) }) },
				{ id: 'user', store: memoryStyleStore({ 'paper/SKILL.md': skill('paper'), 'paper/scene.json': JSON.stringify({ version: 3, palette: { sky: '#fafafa', ground: '#dddddd' }, light: { intensity: 2 } }) }, { night: { enabled: false }, paper: { enabled: false } }) }
			],
			domains: [scene]
		});
		const list = await styles.list();
		expect(list.find((s) => s.name === 'dusk')?.inherits).toEqual(['night', 'paper']);
		const report = await styles.check('scene', {});
		const dusk = (await styles.resolve('scene')).skills.find((s) => s.name === 'dusk');
		expect(dusk?.inherits).toEqual(['night', 'paper']);
		expect(report.style.profile).toMatchObject({ palette: { sky: '#000000', ground: '#dddddd' }, light: { intensity: 2 }, title: 'Dusk' });
	});

	it('choosing a child in a group switches its base off, and the child keeps the base fields', async () => {
		const store = memoryStyleStore({
			'paper/SKILL.md': skill('paper', 'group: look\n'),
			'paper/scene.json': paper['paper/scene.json'],
			'night/SKILL.md': skill('night', 'group: look\nextends: paper\n'),
			'night/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000000' } })
		});
		const styles = createStyleResolver({ layers: [{ id: 'user', store }], domains: [scene] });
		expect((await styles.choose('night')).switchedOff).toEqual(['paper']);
		expect((await styles.resolve('scene')).profile).toMatchObject({ palette: { sky: '#000000', ground: '#eeeeee' }, title: 'Paper' });
	});

	it('refuses a missing base, a circle, a chain too deep and a bad extends, naming the skills', async () => {
		const files: Record<string, string> = {
			'orphan/SKILL.md': skill('orphan', 'extends: missing\n'),
			'orphan/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000' } }),
			'a/SKILL.md': skill('a', 'extends: b\n'),
			'b/SKILL.md': skill('b', 'extends: a\n'),
			'self/SKILL.md': skill('self', 'extends: self\n'),
			'odd/SKILL.md': skill('odd', 'extends: 7\n'),
			'odd/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000' } })
		};
		// level0 extends level1 ... level9 (a chain of nine bases).
		for (let i = 0; i <= MAX_STYLE_INHERITANCE_DEPTH + 1; i++) {
			files[`level${i}/SKILL.md`] = skill(`level${i}`, i <= MAX_STYLE_INHERITANCE_DEPTH ? `extends: level${i + 1}\n` : '');
			files[`level${i}/scene.json`] = JSON.stringify({ version: 3, palette: { sky: '#000' } });
		}
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }], domains: [scene] });
		const byName = Object.fromEntries((await styles.list()).map((s) => [s.name, s]));
		expect(byName.orphan.issues[0]).toMatch(/^Its profiles are left out: it extends "missing", which no layer holds; the skills are /);
		expect(byName.orphan.profiles).toEqual([]);
		expect(byName.a.issues).toEqual(['Its profiles are left out: "extends" goes round in a circle: a → b → a.']);
		expect(byName.self.issues).toEqual(['Its profiles are left out: "extends" goes round in a circle: self → self.']);
		expect(byName.level0.issues[0]).toBe(`Its profiles are left out: "extends" goes more than ${MAX_STYLE_INHERITANCE_DEPTH} skills deep: ${Array.from({ length: MAX_STYLE_INHERITANCE_DEPTH + 2 }, (_, i) => `level${i}`).join(' → ')}.`);
		expect(byName.level1.issues).toEqual([]); // eight bases is the limit, not past it
		expect(byName.odd.issues).toEqual(['"extends" must be the name of another style skill (or null), not 7; its profiles are read without a base.']);
		expect(byName.odd.profiles).toEqual(['scene']);
	});

	it('validates the merged profile, not the partial copy; a base profile for a domain the child leaves out is not inherited', async () => {
		const chartish: StyleDomain = { id: 'other', title: 'Other', description: 'x', profileSchema: { type: 'object', properties: { size: { type: 'number' } }, additionalProperties: false }, checks: [] };
		const styles = createStyleResolver({
			layers: [
				{
					id: 'org',
					store: memoryStyleStore({
						...paper,
						'paper/other.json': JSON.stringify({ size: 3 }),
						'part/SKILL.md': skill('part', 'extends: paper\ndomains: [scene]\n'),
						'part/scene.json': JSON.stringify({ version: 3, light: { intensity: 2 } }),
						'bad/SKILL.md': skill('bad', 'extends: paper\n'),
						'bad/scene.json': JSON.stringify({ version: 3, light: { intensity: 9 } }),
						'lone/SKILL.md': skill('lone'),
						'lone/scene.json': JSON.stringify({ version: 3, light: { intensity: 2 } })
					})
				}
			],
			domains: [scene, chartish]
		});
		const byName = Object.fromEntries((await styles.list()).map((s) => [s.name, s]));
		// No palette of its own, but the merged profile has the base's: valid.
		expect(byName.part).toMatchObject({ profiles: ['scene'], domains: ['scene'], issues: [] });
		expect(byName.bad.issues).toEqual(['scene.json is left out: /light/intensity: Must be <= 4.']);
		expect(byName.lone.issues[0]).toMatch(/^scene\.json is left out: .*palette/);
	});

	it('inherits profiles kept in frontmatter, and the brand', async () => {
		const styles = createStyleResolver({
			layers: [
				{
					id: 'org',
					store: memoryStyleStore({
						'paper/SKILL.md': `---\nname: paper\ndescription: Paper.\nscene:\n  version: 3\n  palette:\n    sky: "#ffffff"\n    ground: "#eeeeee"\n---\n\nPaper.\n`,
						'paper/brand.json': JSON.stringify({ colors: { primary: '#0b5fff' } }),
						'night/SKILL.md': `---\nname: night\ndescription: Night.\nextends: paper\nscene:\n  version: 3\n  palette:\n    sky: "#000000"\n---\n\nNight.\n`
					}, { paper: { enabled: false } })
				}
			],
			domains: [scene]
		});
		expect((await styles.resolve('scene')).profile).toEqual({ palette: { sky: '#000000', ground: '#eeeeee' } });
		expect((await styles.resolve('brand')).profile).toEqual({ colors: { primary: '#0b5fff' } });
	});

	it('an inherited value a locked layer already set is no attempt to change it', async () => {
		const styles = createStyleResolver({
			layers: [
				{ id: 'org', store: memoryStyleStore(paper), locked: true },
				{ id: 'user', store: memoryStyleStore({ 'night/SKILL.md': skill('night', 'extends: paper\n'), 'night/scene.json': JSON.stringify({ version: 3, palette: { sky: '#000000' } }) }) }
			],
			domains: [scene]
		});
		const style = await styles.resolve('scene');
		expect(style.issues.map((i) => i.message)).toEqual(['"palette.sky" is locked by the org layer, so this skill\'s value is ignored.']);
		expect(style.profile).toMatchObject({ palette: { sky: '#ffffff' } });
	});

	it('check, save and remove know about bases', async () => {
		const org = memoryStyleStore(paper);
		const user = memoryStyleStore();
		const styles = createStyleResolver({ layers: [{ id: 'org', store: org }, { id: 'user', store: user }], domains: [scene] });
		const draft = { 'SKILL.md': skill('night', 'extends: paper\n'), 'scene.json': JSON.stringify({ version: 3, palette: { sky: '#000000' } }) };
		const alone = await checkStyleSkill('night', draft, { domains: [scene] });
		expect(alone.ok).toBe(false);
		expect(alone.errors[0]).toMatch(/it extends "paper", which no layer holds/);
		const withBase = await checkStyleSkill('night', draft, { domains: [scene], bases: styles });
		expect(withBase).toMatchObject({ ok: true, inherits: ['paper'], profiles: { scene: { palette: { sky: '#000000', ground: '#eeeeee' }, title: 'Paper' } } });
		const saved = await saveStyleSkill(styles, 'night', draft);
		expect(saved).toMatchObject({ layer: 'user', inherits: ['paper'] });
		await expect(saveStyleSkill(styles, 'dawn', { 'SKILL.md': skill('dawn', 'extends: nowhere\n'), 'scene.json': JSON.stringify({ version: 3, palette: { sky: '#fff' } }) })).rejects.toThrow(/"dawn" was not saved: .*it extends "nowhere"/);
		// Removing the last copy of a base names the skills built on it.
		expect(await removeStyleSkill(styles, 'paper', { layer: 'org' })).toEqual({ name: 'paper', layer: 'org', extendedBy: ['night'] });
		expect((await styles.list()).find((s) => s.name === 'night')?.issues[0]).toMatch(/it extends "paper", which no layer holds/);
	});
	it('the agent tools check, save, read and remove a variant over its base', async () => {
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({ 'paper/SKILL.md': skill('paper'), 'paper/scene.json': JSON.stringify({ version: 3, palette: { sky: '#fff', ground: '#eee' }, title: 'Paper' }) }) }, { id: 'user', store: memoryStyleStore() }], domains: [scene] });
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles, { namespace: '' }));
		const files = { 'SKILL.md': skill('night', 'extends: paper\n'), 'scene.json': JSON.stringify({ version: 3, palette: { sky: '#000' } }) };
		expect((await registry.callTool('check_style_skill', { name: 'night', files })).structuredContent).toMatchObject({ ok: true, inherits: ['paper'], profiles: { scene: { palette: { sky: '#000', ground: '#eee' } } } });
		expect((await registry.callTool('save_style', { name: 'night', files })).structuredContent).toMatchObject({ layer: 'user', inherits: ['paper'] });
		const got = (await registry.callTool('get_style', { domain: 'scene' })).structuredContent as { skills: unknown[]; sources: Record<string, string> };
		expect(got.skills).toContainEqual({ name: 'night', description: 'night look.', layer: 'user', inherits: ['paper'] });
		const bad = await registry.callTool('save_style', { name: 'loop', files: { 'SKILL.md': skill('loop', 'extends: loop\n') } });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toContain('goes round in a circle: loop → loop');
		expect((await registry.callTool('remove_style', { name: 'paper', layer: 'org' })).structuredContent).toEqual({ name: 'paper', layer: 'org', extendedBy: ['night'] });
	});
});

describe('house style: profile versions', () => {
	const resolver = (files: Record<string, string>) => createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }], domains: [scene] });

	it('upgrades older copies one step at a time and reports them, writing nothing back', async () => {
		const files = { 'old/SKILL.md': skill('old'), 'old/scene.json': JSON.stringify({ $schema: './scene.schema.json', sky: '#88ccff', ground: '#eeeeee', title: 'Old' }) };
		const styles = resolver(files);
		const [info] = await styles.list();
		expect(info.issues).toEqual([]);
		expect(info.migrations).toEqual([{ domain: 'scene', file: 'scene.json', from: 1, to: 3, profile: { $schema: './scene.schema.json', version: 3, light: { intensity: 1 }, title: 'Old', palette: { sky: '#88ccff', ground: '#eeeeee' } } }]);
		expect((await styles.resolve('scene')).profile).toEqual({ light: { intensity: 1 }, title: 'Old', palette: { sky: '#88ccff', ground: '#eeeeee' } });
		expect(JSON.parse(files['old/scene.json']).version).toBeUndefined();
		const current = resolver({ 'now/SKILL.md': skill('now'), 'now/scene.json': JSON.stringify({ version: 3, palette: { sky: '#fff' } }) });
		expect((await current.list())[0].migrations).toBeUndefined();
	});

	it('a copy over a base is partial, so the upgrade adds no defaults that would hide the base', async () => {
		const styles = resolver({
			'paper/SKILL.md': skill('paper'),
			'paper/scene.json': JSON.stringify({ version: 3, palette: { sky: '#fff', ground: '#eee' }, light: { intensity: 3 } }),
			'night/SKILL.md': skill('night', 'extends: paper\n'),
			'night/scene.json': JSON.stringify({ version: 2, palette: { sky: '#000' } })
		});
		const night = (await styles.list()).find((s) => s.name === 'night')!;
		expect(night.migrations?.[0]).toMatchObject({ from: 2, to: 3, profile: { version: 3, palette: { sky: '#000' } } });
		expect(night.migrations?.[0].profile.light).toBeUndefined();
	});

	it('refuses newer, malformed and unmigratable versions with the file named', async () => {
		const throwing: StyleDomain = { ...scene, id: 'throwing', migrateProfile: () => { throw new Error('bad shape'); } };
		const nothing: StyleDomain = { ...scene, id: 'nothing', migrateProfile: () => 'nope' as never };
		const fixed: StyleDomain = { ...scene, id: 'fixed', profileVersion: 2, migrateProfile: undefined };
		const styles = createStyleResolver({
			layers: [
				{
					id: 'org',
					store: memoryStyleStore({
						'a/SKILL.md': skill('a'),
						'a/scene.json': JSON.stringify({ version: 4, palette: { sky: '#fff' } }),
						'b/SKILL.md': skill('b'),
						'b/scene.json': JSON.stringify({ version: 1.5, palette: { sky: '#fff' } }),
						'c/SKILL.md': skill('c'),
						'c/throwing.json': JSON.stringify({ sky: '#fff' }),
						'd/SKILL.md': skill('d'),
						'd/nothing.json': JSON.stringify({ sky: '#fff' }),
						'e/SKILL.md': skill('e'),
						'e/fixed.json': JSON.stringify({ palette: { sky: '#fff' } })
					})
				}
			],
			domains: [scene, throwing, nothing, fixed]
		});
		const issues = Object.fromEntries((await styles.list()).map((s) => [s.name, s.issues]));
		expect(issues.a).toEqual(['scene.json is left out: it is version 4; this app reads scene profiles up to version 3. Update the app, or write a version 3 profile.']);
		expect(issues.b).toEqual(['scene.json is left out: "version" must be a whole number from 1 (this app reads scene profiles up to version 3).']);
		expect(issues.c).toEqual(['throwing.json is left out: upgrading it from version 1 failed: bad shape']);
		expect(issues.d).toEqual(['nothing.json is left out: upgrading it from version 1 did not give a profile object.']);
		expect(issues.e).toEqual(['fixed.json is left out: it is version 1, and the fixed domain cannot upgrade it to version 2; rewrite it for version 2 (get_style_schema).']);
	});

	it('a domain without versions treats "version" as an ordinary field', async () => {
		const plain: StyleDomain = { id: 'plain', title: 'Plain', description: 'x', profileSchema: { type: 'object', properties: { size: { type: 'number' } }, additionalProperties: false }, checks: [] };
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({ 'p/SKILL.md': skill('p'), 'p/plain.json': JSON.stringify({ version: 2, size: 1 }) }) }], domains: [plain] });
		expect((await styles.list())[0].issues[0]).toMatch(/^plain\.json is left out: .*version/);
	});

	it('the authoring kit and tools show the version', async () => {
		expect((styleProfileSchema(scene).properties as Record<string, unknown>).version).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
		expect(JSON.parse(scaffoldStyleSkill({ name: 'x', profiles: ['scene'], domains: [scene] })['scene.json'])).toEqual({ version: 3, palette: { sky: '#88ccff', ground: '#eeeeee' } });
		const report = await checkStyleSkill('old', { 'SKILL.md': skill('old'), 'scene.json': JSON.stringify({ sky: '#fff' }) }, { domains: [scene] });
		expect(report.ok).toBe(true);
		expect(report.migrations?.[0]).toMatchObject({ from: 1, to: 3 });
		expect(report.warnings).toContain('scene.json is version 1 and is upgraded to version 3 each time it is read; save the upgraded profile (in migrations) to stop that.');
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(resolver({ 'old/SKILL.md': skill('old'), 'old/scene.json': JSON.stringify({ sky: '#fff' }) }), { namespace: '' }));
		expect((await registry.callTool('get_style_schema', { domain: 'scene' })).structuredContent).toMatchObject({ version: 3, example: { version: 3 } });
		const listed = (await registry.callTool('list_styles', {})).structuredContent as { skills: { migrations?: unknown[] }[] };
		expect(listed.skills[0].migrations).toHaveLength(1);
	});
});
