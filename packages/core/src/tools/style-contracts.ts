/**
 * The `style` domain of `@pixerate/conformance` (#890): the style resolver and its read tools
 * (`list_styles`, `get_style`, `get_style_file`, `get_style_schema`) as recorded tool calls over
 * layers of memory stores, for the Swift port in PixerateCore to reproduce exactly. Scenarios use
 * the document (`rich-text`) domain and the brand. `domains.json` holds what `get_style_schema`
 * returns for each, so the Swift port serves the same text without porting the authoring kit.
 */
import { createStyleResolver, memoryStyleStore, type StyleSkillState, type StyleTokenSource } from './style.js';
import { createStyleToolProvider } from './style-tools.js';
import { ToolRegistry } from './registry.js';
import { richTextStyleDomain } from '../richTextStyle.js';

/** One layer of a scenario: its id, flags, files keyed `<skill>/<file>` and state per skill. */
export interface StyleScenarioLayer {
	id: string;
	locked?: boolean;
	required?: boolean;
	files: Record<string, string>;
	state?: Record<string, StyleSkillState>;
}

export interface StyleScenarioCall {
	tool: 'list_styles' | 'get_style' | 'get_style_file' | 'get_style_schema';
	args: Record<string, unknown>;
}

export interface StyleScenario {
	name: string;
	layers: StyleScenarioLayer[];
	/** Design tokens by name; `name@mode` for a mode's value. Without them, `$token` references fail. */
	tokens?: Record<string, string | number | boolean>;
	/** The tools' scope (`report`, ...). */
	scope?: string;
	calls: StyleScenarioCall[];
}

/** The token source scenarios use: values by name, or `name@mode`. */
export function scenarioTokenSource(tokens: Readonly<Record<string, string | number | boolean>>): StyleTokenSource {
	return {
		resolve: ({ token, mode }) => {
			const key = mode ? `${token}@${mode}` : token;
			return key in tokens ? { ok: true, value: tokens[key] } : { ok: false, message: `"${key}" is not a design token here.` };
		}
	};
}

const skill = (name: string, description: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

/** The scenarios of the contract. */
export const STYLE_SCENARIOS: readonly StyleScenario[] = [
	{
		name: 'two layers merge: org prose and profile, a user override, sources per field',
		layers: [
			{
				id: 'org',
				files: {
					'house/SKILL.md': skill('house', 'Acme house writing style.', '# Acme style\n\nWrite plainly and warmly. Prefer short sentences.', 'domains: [rich-text]\n'),
					'house/rich-text.json': JSON.stringify({ headingCase: 'title', listItemEnd: 'none', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case', 'terms'] }),
					'house/references/tone.md': '# Tone\n\nFriendly, never flippant.\n'
				}
			},
			{
				id: 'user',
				files: {
					'mine/SKILL.md': skill('mine', 'My own tweaks.', 'I like sentence case.', 'domains: rich-text\n'),
					'mine/rich-text.json': JSON.stringify({ headingCase: 'sentence', properNouns: ['Acme'] })
				}
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'list_styles', args: { domain: 'rich-text' } },
			{ tool: 'get_style', args: { domain: 'rich-text' } },
			{ tool: 'get_style', args: { domain: 'brand' } },
			{ tool: 'get_style_file', args: { name: 'house', file: 'references/tone.md' } },
			{ tool: 'get_style_file', args: { name: 'house', file: 'rich-text.json' } },
			{ tool: 'get_style_file', args: { name: 'house', file: 'SKILL.md' } },
			{ tool: 'get_style_schema', args: { domain: 'rich-text' } },
			{ tool: 'get_style_schema', args: { domain: 'brand' } }
		]
	},
	{
		name: 'a locked layer keeps its fields and its copy; a required layer keeps its skills on',
		layers: [
			{
				id: 'org',
				locked: true,
				files: {
					'house/SKILL.md': skill('house', 'Locked org style.', 'Org rules.'),
					'house/rich-text.json': JSON.stringify({ headingCase: 'sentence', terms: [{ avoid: 'synergy' }] })
				}
			},
			{
				id: 'team',
				required: true,
				files: { 'team/SKILL.md': skill('team', 'Team style.', 'Team rules.'), 'team/rich-text.json': JSON.stringify({ dateFormat: 'iso', quotes: 'curly' }) }
			},
			{
				id: 'user',
				files: {
					'house/SKILL.md': skill('house', 'User copy of house.', 'Ignored.'),
					'mine/SKILL.md': skill('mine', 'Mine.', 'My rules.'),
					'mine/rich-text.json': JSON.stringify({ headingCase: 'title', headingCase2: undefined, dateFormat: 'day-month-year', maxHeadingLevel: 3 })
				},
				state: { team: { enabled: false } }
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } },
			{ tool: 'get_style_file', args: { name: 'house', file: 'SKILL.md' } }
		]
	},
	{
		name: 'state: off, order, one-of-a-kind groups and scopes',
		scope: 'report',
		layers: [
			{
				id: 'org',
				files: {
					'plain/SKILL.md': skill('plain', 'Plain look.', 'Plain.', 'group: look\n'),
					'plain/rich-text.json': JSON.stringify({ quotes: 'straight' }),
					'fancy/SKILL.md': skill('fancy', 'Fancy look.', 'Fancy.', 'group: look\n'),
					'fancy/rich-text.json': JSON.stringify({ quotes: 'curly' }),
					'reports/SKILL.md': skill('reports', 'Only in reports.', 'Report rules.'),
					'reports/rich-text.json': JSON.stringify({ maxHeadingLevel: 2 }),
					'slides/SKILL.md': skill('slides', 'Only in slides.', 'Slide rules.'),
					'slides/rich-text.json': JSON.stringify({ maxHeadingLevel: 1 }),
					'zz-first/SKILL.md': skill('zz-first', 'Ordered first.', 'First.'),
					'off/SKILL.md': skill('off', 'Switched off.', 'Off.')
				},
				state: { plain: { order: 2 }, 'zz-first': { order: -1 }, reports: { scope: ['report'] }, slides: { scope: ['slides'] }, off: { enabled: false } }
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } }
		]
	},
	{
		name: 'extends: a chain, a cycle, a missing base and a bad value',
		layers: [
			{
				id: 'org',
				files: {
					'base/SKILL.md': skill('base', 'The base.', 'Base prose.'),
					'base/rich-text.json': JSON.stringify({ headingCase: 'title', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case'] }),
					'mid/SKILL.md': skill('mid', 'Builds on base.', 'Mid prose.', 'extends: base\n'),
					'mid/rich-text.json': JSON.stringify({ quotes: 'curly' }),
					'leaf/SKILL.md': skill('leaf', 'Builds on mid.', 'Leaf prose.', 'extends: mid\n'),
					'leaf/rich-text.json': JSON.stringify({ headingCase: 'sentence' }),
					'loop-a/SKILL.md': skill('loop-a', 'A loop.', 'A.', 'extends: loop-b\n'),
					'loop-a/rich-text.json': JSON.stringify({ quotes: 'straight' }),
					'loop-b/SKILL.md': skill('loop-b', 'B loop.', 'B.', 'extends: loop-a\n'),
					'orphan/SKILL.md': skill('orphan', 'Missing base.', 'Orphan.', 'extends: nowhere\n'),
					'orphan/rich-text.json': JSON.stringify({ quotes: 'straight' }),
					'odd/SKILL.md': skill('odd', 'Bad extends.', 'Odd.', 'extends: [base]\n')
				},
				state: { base: { enabled: false }, mid: { enabled: false } }
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } }
		]
	},
	{
		name: 'design tokens, a brand with its derived profile, swatches and $brand.checks',
		tokens: { 'brand/primary': '#0b5fff', 'brand/text': '#1a1a1a', 'brand/text@Dark': '#f5f5f5', 'type/body': 'Inter' },
		layers: [
			{
				id: 'org',
				files: {
					'brand/SKILL.md': skill('brand', 'Acme brand.', 'Use the brand colours.'),
					'brand/brand.json': JSON.stringify({
						name: 'Acme',
						colors: { primary: { $token: 'brand/primary' }, text: { $token: 'brand/text', mode: 'Dark' }, background: '#ffffff' },
						palette: ['#0b5fff', '#ff6a00'],
						fonts: { heading: 'Georgia', body: { $token: 'type/body' } },
						checks: ['palette-only', 'fonts-allowed']
					}),
					'tokens-bad/SKILL.md': skill('tokens-bad', 'A missing token.', 'Bad.'),
					'tokens-bad/rich-text.json': JSON.stringify({ quotes: { $token: 'nope' }, headingCase: 'sentence' }),
					'tokens-shape/SKILL.md': skill('tokens-shape', 'A malformed reference.', 'Bad.'),
					'tokens-shape/rich-text.json': JSON.stringify({ quotes: { $token: 'brand/primary', extra: 1 } })
				}
			},
			{
				id: 'user',
				files: { 'mine/SKILL.md': skill('mine', 'My palette.', 'Mine.'), 'mine/rich-text.json': JSON.stringify({ palette: ['#123456', '#0B5FFF'] }) }
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } },
			{ tool: 'get_style', args: { domain: 'brand' } }
		]
	},
	{
		name: 'frontmatter: profiles under a key, unknown domains, broken YAML and bad files',
		layers: [
			{
				id: 'org',
				files: {
					'inline/SKILL.md': '---\nname: inline\ndescription: >\n  A profile kept in\n  the frontmatter.\ndomains: [rich-text, chart]\nrich-text:\n  headingCase: upper\n  terms:\n    - avoid: "leverage"\n      use: use\n    - { avoid: synergy, note: \'jargon\' }\n---\n\nInline prose.\n',
					'both/SKILL.md': '---\nname: both\ndescription: File and frontmatter\nrich-text: { quotes: curly }\n---\nBody.\n',
					'both/rich-text.json': JSON.stringify({ quotes: 'straight' }),
					'broken/SKILL.md': '---\nname: broken\ndescription: "unclosed\ndomains: [rich-text]\ngroup: look\n---\nBroken prose.\n',
					'badprofile/SKILL.md': skill('badprofile', 'An invalid profile.', 'Bad.'),
					'badprofile/rich-text.json': JSON.stringify({ headingCase: 'shouty', maxHeadingLevel: 9, checks: ['heading-case', { id: 'terms', extra: true }, 7] }),
					'notobject/SKILL.md': skill('notobject', 'A profile that is a list.', 'List.'),
					'notobject/rich-text.json': '[1, 2]',
					'outside/SKILL.md': skill('outside', 'A profile for a domain it leaves out.', 'Out.', 'domains: [brand]\n'),
					'outside/rich-text.json': JSON.stringify({ quotes: 'curly' }),
					'Bad_Name/SKILL.md': skill('Bad_Name', 'Invalid name.', 'Bad.'),
					'files/SKILL.md': skill('files', 'Odd files.', 'Files.'),
					'files/.hidden.md': 'hidden',
					'files/image.png': 'not text',
					'files/a/b/c/d/e/deep.md': 'too deep',
					'files/notes.md': 'Notes.'
				}
			}
		],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } },
			{ tool: 'get_style_file', args: { name: 'files', file: 'notes.md' } },
			{ tool: 'get_style_file', args: { name: 'files', file: 'missing.md' } },
			{ tool: 'get_style_file', args: { name: 'files', file: '../escape.md' } },
			{ tool: 'get_style_file', args: { name: 'files', file: 'image.png' } },
			{ tool: 'get_style_file', args: { name: 'nobody', file: 'SKILL.md' } }
		]
	},
	{
		name: 'no house style',
		layers: [{ id: 'org', files: {} }],
		calls: [
			{ tool: 'list_styles', args: {} },
			{ tool: 'get_style', args: { domain: 'rich-text' } },
			{ tool: 'get_style_file', args: { name: 'house', file: 'SKILL.md' } }
		]
	}
];

/** What one tool call returned: the structured result, the text when the tool writes its own, and the error. */
export interface StyleCallResult {
	isError: boolean;
	structuredContent?: Record<string, unknown>;
	text?: string;
	error?: string;
}

/** Runs a scenario through `createStyleToolProvider`, as the contract records it. */
export async function runStyleScenario(scenario: StyleScenario): Promise<StyleCallResult[]> {
	const styles = createStyleResolver({
		layers: scenario.layers.map((l) => ({ id: l.id, store: memoryStyleStore(l.files, l.state ?? {}), ...(l.locked ? { locked: true } : {}), ...(l.required ? { required: true } : {}) })),
		domains: [richTextStyleDomain],
		...(scenario.tokens ? { tokens: scenarioTokenSource(scenario.tokens) } : {})
	});
	const registry = new ToolRegistry();
	registry.register(createStyleToolProvider(styles, { namespace: '', ...(scenario.scope !== undefined ? { scope: scenario.scope } : {}) }));
	const out: StyleCallResult[] = [];
	for (const call of scenario.calls) {
		const result = await registry.callTool(call.tool, call.args);
		const text = (result.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text;
		if (result.isError) {
			out.push({ isError: true, error: (result.structuredContent?.error as { message?: string } | undefined)?.message ?? text });
			continue;
		}
		// The tools that write their own text (get_style, get_style_file, get_style_schema) are compared on it too.
		const ownText = call.tool !== 'list_styles';
		out.push({ isError: false, ...(result.structuredContent ? { structuredContent: JSON.parse(JSON.stringify(result.structuredContent)) } : {}), ...(ownText && text !== undefined ? { text } : {}) });
	}
	return out;
}

/** The files of `packages/conformance/domains/style`. */
export async function styleContracts(): Promise<Record<string, unknown>> {
	const styles = createStyleResolver({ layers: [], domains: [richTextStyleDomain] });
	const registry = new ToolRegistry();
	registry.register(createStyleToolProvider(styles, { namespace: '' }));
	const domains: Record<string, unknown>[] = [];
	for (const d of styles.domains) {
		const result = await registry.callTool('get_style_schema', { domain: d.id });
		domains.push({ id: d.id, title: d.title, text: (result.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text, structuredContent: result.structuredContent });
	}
	const tools = registry
		.listTools()
		.tools.filter((t) => ['list_styles', 'get_style', 'get_style_file', 'get_style_schema'].includes(t.name));
	const scenarios = [];
	for (const s of STYLE_SCENARIOS) scenarios.push({ ...JSON.parse(JSON.stringify(s)), expected: await runStyleScenario(s) });
	return {
		'manifest.json': {
			domain: 'style',
			formatVersion: 1,
			description:
				'The style resolver (layers, locks, required layers, skill state, groups, scopes, extends, $token references, frontmatter profiles, the brand and file limits) and its read tools, as recorded tool calls over memory stores, with the rich-text and brand domains. domains.json is what get_style_schema returns for each.',
			files: ['domains.json', 'tools.json', 'scenarios.json']
		},
		'domains.json': domains,
		'tools.json': tools,
		'scenarios.json': scenarios
	};
}
