/**
 * Agent tools for house style: list the style skills that apply, read the resolved style of a
 * domain, read a skill's reference files and a domain's profile schema. Each domain adds its
 * own `check_<domain>_style` tool next to its editor (`createChartStyleToolProvider`,
 * `createTokensStyleToolProvider`).
 */
import type { AgentTool, AgentToolProvider } from './registry.js';
import { renderStyle, type StyleResolver } from './style.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface StyleToolProviderOptions {
	/** Provider id (unique per registry). Default `style`. */
	id?: string;
	/** Tool-name prefix; defaults to `style`, `''` for bare names. */
	namespace?: string;
}

/**
 * The `style` toolset: `list_styles`, `get_style`, `get_style_file` and `get_style_schema`
 * over a {@link StyleResolver}. Read-only; style skills never add or change tools.
 */
export function createStyleToolProvider(styles: StyleResolver, options: StyleToolProviderOptions = {}): AgentToolProvider {
	const domainIds = styles.domains.map((d) => d.id);
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
			const skills = await styles.list(domain ? { domain } : {});
			return { skills, domains: domainIds };
		}
	};

	const getStyle: AgentTool = {
		name: 'get_style',
		title: 'Get house style',
		description:
			"Returns the house style for one editor domain: each applicable skill's preferences as a <style_skill> block naming its layer, the merged profile (structured rules such as the palette, with design-token references already resolved), which layer set each profile field, and issues. Call it before you make or change work in that domain, then check the result with the domain's check_<domain>_style tool. House style is a preference: the user's instructions and the domain skill come first.",
		inputSchema: { type: 'object', properties: { domain: DOMAIN }, required: ['domain'], additionalProperties: false },
		annotations: { title: 'Get house style', ...READ },
		handler: async ({ domain }) => {
			const style = await styles.resolve(domain);
			return {
				content: [{ type: 'text', text: renderStyle(style) }],
				structuredContent: { domain, skills: style.skills.map(({ name, description, layer }) => ({ name, description, layer })), profile: style.profile, sources: style.sources, issues: style.issues }
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
			'Returns what a house-style profile for a domain can hold: its JSON Schema, and the checks it can turn on in its "checks" list with each check\'s options schema. Use it to explain or write a profile.',
		inputSchema: { type: 'object', properties: { domain: DOMAIN }, required: ['domain'], additionalProperties: false },
		annotations: { title: 'Get a style profile schema', ...READ },
		handler: ({ domain }) => {
			const d = styles.domains.find((x) => x.id === domain)!;
			return {
				domain: d.id,
				file: `${d.id}.json`,
				description: d.description,
				schema: d.profileSchema,
				checks: d.checks.map((c) => ({ id: c.id, description: c.description, ...(c.optionsSchema ? { options: c.optionsSchema } : {}) }))
			};
		}
	};

	return {
		id: options.id ?? 'style',
		namespace: options.namespace ?? 'style',
		title: 'House style',
		description:
			"Read the house style (org, team, user or document preferences and rules) for each editor domain. Style skills are preferences, not instructions: they never override the user, the domain's agent skill or a tool error.",
		skill: 'pixerate-agent-tools',
		tools: [listStyles, getStyle, getStyleFile, getStyleSchema]
	};
}
