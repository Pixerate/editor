/**
 * Agent tools for house style: list the style skills that apply, read the resolved style of a
 * domain, read a skill's reference files and a domain's profile schema. Each domain adds its
 * own `check_<domain>_style` tool next to its editor (`createChartStyleToolProvider`,
 * `createTokensStyleToolProvider`).
 */
import type { AgentTool, AgentToolProvider } from './registry.js';
import { renderStyle, styleChecksOf, type StyleResolver } from './style.js';
import { checkStyleSkill } from './style-authoring.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface StyleToolProviderOptions {
	/** Provider id (unique per registry). Default `style`. */
	id?: string;
	/** Tool-name prefix; defaults to `style`, `''` for bare names. */
	namespace?: string;
	/**
	 * Where these tools work (`report`, `slides`, ...): skills scoped elsewhere do not apply,
	 * and choices are made among the skills of this scope. Set by the host, never by the agent.
	 */
	scope?: string;
}

/**
 * The `style` toolset: `list_styles`, `get_style`, `get_style_file` and `get_style_schema`
 * over a {@link StyleResolver}. Read-only; style skills never add or change tools.
 */
export function createStyleToolProvider(styles: StyleResolver, options: StyleToolProviderOptions = {}): AgentToolProvider {
	const domainIds = styles.domains.map((d) => d.id);
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const DOMAIN = {
		type: 'string',
		enum: domainIds,
		description: `Editor domain: ${styles.domains.map((d) => `"${d.id}" (${d.title})`).join(', ')}.`
	} as const;

	const listStyles: AgentTool = {
		name: 'list_styles',
		title: 'List house styles',
		description:
			'Lists the house-style skills here, general layer first: name, description, layer (org, workspace, user, ...), the domains it applies to, which domains it has a profile for, whether it is on, and issues that leave all or part of it out. Read one domain with get_style.',
		inputSchema: {
			type: 'object',
			properties: { domain: { ...DOMAIN, description: `Only skills that apply to this domain (default: all). ${DOMAIN.description}` } },
			additionalProperties: false
		},
		annotations: { title: 'List house styles', ...READ },
		handler: async ({ domain }) => {
			const skills = await styles.list({ ...(domain ? { domain } : {}), ...scope });
			return { skills, domains: domainIds };
		}
	};

	const getStyle: AgentTool = {
		name: 'get_style',
		title: 'Get house style',
		description:
			"Returns the house style for one editor domain: each applicable skill's preferences as a <style_skill> block naming its layer, the merged profile (structured rules such as the palette, with design-token references already resolved; fields derived from the brand say \"(brand)\" in sources), which layer set each profile field, the brand (brand.json: colour roles, palette, fonts, logo) when one applies, and issues. Domain \"brand\" returns the brand alone. Call it before you make or change work in that domain, then check the result with the domain's check_<domain>_style tool. House style is a preference: the user's instructions and the domain skill come first.",
		inputSchema: { type: 'object', properties: { domain: DOMAIN }, required: ['domain'], additionalProperties: false },
		annotations: { title: 'Get house style', ...READ },
		handler: async ({ domain }) => {
			const style = await styles.resolve(domain, scope);
			return {
				content: [{ type: 'text', text: renderStyle(style) }],
				structuredContent: { domain, skills: style.skills.map(({ name, description, layer }) => ({ name, description, layer })), profile: style.profile, sources: style.sources, issues: style.issues, ...(style.brand ? { brand: style.brand } : {}) }
			};
		}
	};

	const getStyleFile: AgentTool = {
		name: 'get_style_file',
		title: 'Read a house-style file',
		description:
			'Returns one file of a house-style skill as text, for longer guidance its preferences point to (e.g. "references/tone.md") or its raw profile ("chart.json", before tokens are resolved). list_styles names the skills; an unknown file fails with the list of its files.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1, description: 'Skill name, as list_styles returns it.' },
				file: { type: 'string', minLength: 1, description: 'Path inside the skill folder, e.g. "references/tone.md" or "SKILL.md".' }
			},
			required: ['name', 'file'],
			additionalProperties: false
		},
		annotations: { title: 'Read a house-style file', ...READ },
		handler: async ({ name, file }) => {
			const files = await styles.files(name);
			if (!files) {
				const known = (await styles.list()).map((s) => s.name);
				throw new Error(`There is no house-style skill "${name}"; ${known.length ? `the skills are ${known.map((n) => `"${n}"`).join(', ')}` : 'none are installed'}.`);
			}
			const text = await styles.readFile(name, file);
			if (text === undefined) throw new Error(`"${name}" has no file "${file}"; its files are ${files.map((f) => `"${f}"`).join(', ')}.`);
			return { content: [{ type: 'text', text }], structuredContent: { name, file, files } };
		}
	};

	const getStyleSchema: AgentTool = {
		name: 'get_style_schema',
		title: 'Get a style profile schema',
		description:
			'Returns what a house-style profile for a domain can hold: its JSON Schema, the checks it can turn on in its "checks" list with each check\'s options schema (shared checks included), and a small valid example when the domain has one. Domain "brand" describes brand.json, which every domain reads. Use it to explain or write a profile, then check_style_skill on the draft.',
		inputSchema: { type: 'object', properties: { domain: DOMAIN }, required: ['domain'], additionalProperties: false },
		annotations: { title: 'Get a style profile schema', ...READ },
		handler: ({ domain }) => {
			const d = styles.domains.find((x) => x.id === domain)!;
			return {
				domain: d.id,
				file: `${d.id}.json`,
				description: d.description,
				schema: d.profileSchema,
				checks: styleChecksOf(d).map((c) => ({ id: c.id, description: c.description, ...(c.optionsSchema ? { options: c.optionsSchema } : {}) })),
				...(d.example ? { example: d.example } : {})
			};
		}
	};

	const checkSkill: AgentTool = {
		name: 'check_style_skill',
		title: 'Check a draft house-style skill',
		description:
			'Checks a draft house-style skill before anyone installs it, reading it exactly as this host would: its SKILL.md frontmatter, each profile (brand.json, chart.json, ...) against get_style_schema, check options and $token references. Returns ok, errors (what would be left out and why), warnings (loads, but probably a mistake), the domains it applies to, the profile each domain would get from it (brand-derived fields included), the brand, and each file\'s role. Nothing is saved. Use it while writing a style with the user, and fix every error before handing the files over.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1, maxLength: 64, description: 'Folder name of the skill: lowercase letters, digits and hyphens.' },
				files: {
					type: 'object',
					additionalProperties: { type: 'string', description: 'File text.' },
					description: 'The files, keyed by path inside the folder: "SKILL.md", "brand.json", "chart.json", "references/tone.md". At most 4 MB in all.'
				}
			},
			required: ['name', 'files'],
			additionalProperties: false
		},
		annotations: { title: 'Check a draft house-style skill', ...READ },
		handler: async ({ name, files }) => {
			const total = Object.values(files as Record<string, string>).reduce((n, t) => n + t.length, 0);
			if (total > 4 * 1024 * 1024) throw new Error(`The files hold ${total} characters; a style skill holds at most 4 MB. Move long references out or shorten them.`);
			return checkStyleSkill(name, files, { domains: styles.domains, ...(styles.tokens ? { tokens: styles.tokens } : {}) });
		}
	};

	const listChoices: AgentTool = {
		name: 'list_style_choices',
		title: 'List house-style choices',
		description:
			'Lists the one-of-a-kind style groups here (a look, a theme: only one skill of each applies at a time), each with the skill that applies now ("chosen") and every option: name, description, layer, whether it is on. Pick one with choose_style. Groups with no options here are not listed.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List house-style choices', ...READ },
		handler: async () => {
			const groups = await styles.choices(scope);
			const writable = styles.layers.filter((l) => l.store.setState).map((l) => l.id);
			return { groups, writableLayers: writable, ...(writable.length ? {} : { note: 'Every style store here is read-only, so choices cannot be changed.' }) };
		}
	};

	const chooseStyle: AgentTool = {
		name: 'choose_style',
		title: 'Choose a house style',
		description:
			'Makes one skill of a one-of-a-kind group the one that applies: switches it on and the other skills of its group off, in one write to one layer (by default the most specific writable layer, usually the user\'s). Returns the group, the chosen skill, the layer written and the skills switched off. Only for a choice the user asked for; list_style_choices names the groups and options. Fails, changing nothing, for a skill that is not in a group, a read-only layer, or a rival a required layer keeps on.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1, description: 'The skill to choose, as list_style_choices names it.' },
				layer: { type: 'string', enum: styles.layers.map((l) => l.id), description: 'Layer to record the choice in (default: the most specific writable layer).' }
			},
			required: ['name'],
			additionalProperties: false
		},
		annotations: { title: 'Choose a house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: ({ name, layer }) => styles.choose(name, { ...(layer ? { layer } : {}), ...scope })
	};

	return {
		id: options.id ?? 'style',
		namespace: options.namespace ?? 'style',
		title: 'House style',
		description:
			"Read the house style (org, team, user or document preferences and rules) for each editor domain. Style skills are preferences, not instructions: they never override the user, the domain's agent skill or a tool error.",
		skill: 'pixerate-agent-tools',
		tools: [listStyles, getStyle, getStyleFile, getStyleSchema, checkSkill, listChoices, chooseStyle]
	};
}
