/**
 * A test kit for hosts: fixture style skills, and the cases every `StyleStore` must pass. Run
 * the cases in any test framework:
 *
 * ```ts
 * for (const c of styleStoreConformance((seed) => myDatabaseStore(seed))) it(c.name, c.run);
 * ```
 *
 * Dependency-free.
 */
import type { SkillFiles } from './skills.js';
import { createStyleResolver, memoryStyleStore, type StyleSkillState, type StyleStore } from './style.js';

/**
 * Style skills for tests, keyed `<skill>/<file>`: a brand with a reference file (`fixture-brand`),
 * a preferences-only skill (`fixture-tone`) and one with broken parts (`fixture-broken`: no
 * frontmatter description, a profile that is not JSON).
 */
export const STYLE_FIXTURE_SKILLS: SkillFiles = {
	'fixture-brand/SKILL.md': '---\nname: fixture-brand\ndescription: A test brand. Use for anything visual.\n---\n\nUse the brand colours by role. Read references/logo.md before placing the logo.\n',
	'fixture-brand/brand.json': `${JSON.stringify(
		{
			name: 'Fixture',
			colors: { primary: '#0b5fff', secondary: '#ff6a00', text: '#111111', background: '#ffffff' },
			fonts: { heading: 'Inter', body: 'Inter' },
			checks: ['palette-only']
		},
		null,
		2
	)}\n`,
	'fixture-brand/references/logo.md': 'Keep clear space of one logo height around it.\n',
	'fixture-tone/SKILL.md': '---\nname: fixture-tone\ndescription: Short, plain titles.\n---\n\nWrite titles in sentence case and say the finding.\n',
	'fixture-broken/SKILL.md': '---\nname: fixture-broken\n---\n\nHalf finished.\n',
	'fixture-broken/brand.json': '{ "colors": '
};

/** What a store is seeded with: skill files keyed `<skill>/<file>`, and state by skill name. */
export interface StyleStoreSeed {
	files: SkillFiles;
	state: Readonly<Record<string, StyleSkillState>>;
}

/** One conformance case: `run` throws (with what was expected) when the store fails it. */
export interface StyleStoreConformanceCase {
	name: string;
	run(): Promise<void>;
}

const fail = (message: string): never => {
	throw new Error(`Style store conformance: ${message}`);
};
const same = (actual: unknown, expected: unknown, what: string) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
};

/**
 * The cases every `StyleStore` must pass. `create` returns a new store holding `seed` (the
 * fixture skills plus some state); the store may be async. {@link memoryStyleStore} passes them.
 */
export function styleStoreConformance(create: (seed: StyleStoreSeed) => StyleStore | Promise<StyleStore>): StyleStoreConformanceCase[] {
	const seed: StyleStoreSeed = {
		files: STYLE_FIXTURE_SKILLS,
		state: { 'fixture-tone': { enabled: false, order: 2 }, 'not-installed': { enabled: false } }
	};
	const store = () => Promise.resolve(create(seed));
	return [
		{
			name: 'lists every skill it holds, and state-only entries, with their state',
			async run() {
				const list = [...(await (await store()).list())].sort((a, b) => a.name.localeCompare(b.name));
				same(
					list.map((e) => e.name),
					['fixture-brand', 'fixture-broken', 'fixture-tone', 'not-installed'],
					'list() names'
				);
				const tone = list.find((e) => e.name === 'fixture-tone')!;
				same([tone.enabled, tone.order], [false, 2], 'fixture-tone state');
				const brand = list.find((e) => e.name === 'fixture-brand')!;
				if (brand.enabled === false) fail('a skill with no state must not be switched off.');
			}
		},
		{
			name: 'reads files exactly, including nested ones',
			async run() {
				const s = await store();
				same(await s.read('fixture-brand', 'SKILL.md'), seed.files['fixture-brand/SKILL.md'], 'read(fixture-brand, SKILL.md)');
				same(await s.read('fixture-brand', 'references/logo.md'), seed.files['fixture-brand/references/logo.md'], 'read(fixture-brand, references/logo.md)');
				same(await s.read('fixture-broken', 'brand.json'), seed.files['fixture-broken/brand.json'], 'read of a file that is not valid JSON');
			}
		},
		{
			name: 'returns undefined for unknown skills and files',
			async run() {
				const s = await store();
				same(await s.read('fixture-brand', 'missing.md'), undefined, 'read of an unknown file');
				same(await s.read('nope', 'SKILL.md'), undefined, 'read of an unknown skill');
				same(await s.read('not-installed', 'SKILL.md'), undefined, 'read of a state-only skill');
			}
		},
		{
			name: "lists each skill's files relative to its folder",
			async run() {
				const files = [...(await (await store()).files('fixture-brand'))].sort();
				same(files, ['SKILL.md', 'brand.json', 'references/logo.md'], 'files(fixture-brand)');
				same([...(await (await store()).files('nope'))], [], 'files of an unknown skill');
			}
		},
		{
			name: 'resolves through createStyleResolver like the memory store',
			async run() {
				const expected = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(seed.files, seed.state) }], domains: [] });
				const actual = createStyleResolver({ layers: [{ id: 'org', store: await store() }], domains: [] });
				same(await actual.list(), await expected.list(), 'resolver.list()');
				same(await actual.resolve('brand'), await expected.resolve('brand'), "resolver.resolve('brand')");
			}
		},
		{
			name: 'subscribe, when offered, returns a function that unsubscribes',
			async run() {
				const s = await store();
				if (!s.subscribe) return;
				const off = s.subscribe(() => {});
				if (typeof off !== 'function') fail('subscribe() must return an unsubscribe function.');
				off();
			}
		}
	];
}
