/**
 * House-style skills: preferences and rules a host hands agents at runtime, per editor domain.
 *
 * A style skill is a folder like a built-in agent skill: a `SKILL.md` of prose preferences
 * (frontmatter `name`, `description` and optionally `domains`) plus one optional profile per
 * domain (`chart.json`, `tokens.json`) holding structured rules. Hosts keep style skills in
 * layers (org, workspace, user, ...); a {@link StyleResolver} merges them per domain, resolves
 * `$token` references and runs the domain's checks. Dependency-free: domains bring their own
 * profile schema and checks (`chartStyleDomain`, `tokensStyleDomain`).
 */
import { validateJsonSchema, type JsonSchema } from './schema.js';
import { stripPrototypeKeys, isUnsafeJsonKey } from './safe-json.js';
import { parseSkillFrontmatter, type SkillFiles } from './skills.js';

type MaybePromise<T> = T | Promise<T>;

/** What a store records about one style skill, apart from its files. */
export interface StyleSkillState {
	/** `false` switches the skill off (also for a skill another layer holds). Default on. */
	enabled?: boolean;
	/** Sort key among skills of the same layer (lower first, default 0). */
	order?: number;
}

/** One entry of {@link StyleStore.list}: a skill this store holds, or state for another layer's. */
export interface StyleStoreEntry extends StyleSkillState {
	name: string;
}

/**
 * Where one layer's style skills live. Hosts implement it over their own storage (a database,
 * a bucket, the file system); {@link memoryStyleStore} holds skills in memory.
 */
export interface StyleStore {
	/** Skill names with their state. An entry whose `SKILL.md` this store lacks only carries state. */
	list(): MaybePromise<readonly StyleStoreEntry[]>;
	/** A file of a skill (`SKILL.md`, `chart.json`, `references/x.md`), or `undefined`. */
	read(name: string, file: string): MaybePromise<string | undefined>;
	/** Every file of a skill, relative to its folder. */
	files(name: string): MaybePromise<readonly string[]>;
	/** Called when the store's skills or state change; returns an unsubscribe function. */
	subscribe?(listener: () => void): () => void;
}

/** A layer of style skills, from general (first) to specific (last). */
export interface StyleLayer {
	/** Layer id, shown to agents as where a rule came from: `org`, `workspace`, `user`, ... */
	id: string;
	store: StyleStore;
	/**
	 * Later layers cannot replace this layer's skills or change the profile fields it sets.
	 * Their attempts are left out and reported as issues.
	 */
	locked?: boolean;
	/** Later layers cannot switch this layer's skills off. */
	required?: boolean;
}

/** A finding: one house-style rule the current state breaks. */
export interface StyleFinding {
	/** Id of the check that found it. */
	check: string;
	severity: 'error' | 'warning' | 'info';
	/** What is wrong and how to fix it, in one sentence. */
	message: string;
	/** What it is about, in the shape the domain's write tools take (e.g. a chart selection). */
	target?: unknown;
	/** The layer whose profile asked for the check. */
	layer?: string;
}

/**
 * A rule a domain can check. A profile turns it on by id in its `checks` list, with options:
 * `"palette-only"` or `{ "id": "min-contrast", "ratio": 4.5 }`.
 */
export interface StyleCheck<State = unknown> {
	id: string;
	/** What it checks, for agents and admin screens. */
	description: string;
	/** Schema of its options (validated when a profile loads). Default: no options. */
	optionsSchema?: JsonSchema;
	/** The findings for `state` under the resolved `profile`. Throwing reports the check as skipped. */
	run(state: State, profile: Readonly<Record<string, unknown>>, options: Readonly<Record<string, unknown>>): readonly Omit<StyleFinding, 'check' | 'layer'>[];
}

/** An editor domain that can have a house style: its profile file, schema and checks. */
export interface StyleDomain<State = unknown> {
	/** Domain id, the domain skill's name without `pixerate-` (`chart`, `tokens`). The profile file is `<id>.json`. */
	id: string;
	title: string;
	/** What a profile for this domain can set. */
	description: string;
	/** Schema of the profile (the `checks` property is validated separately). */
	profileSchema: JsonSchema & { type: 'object' };
	checks: readonly StyleCheck<State>[];
}

/** A `$token` reference in a profile: `{ "$token": "brand/primary", "mode": "Dark" }`. */
export interface StyleTokenRef {
	/** Variable name (`brand/primary`) or id. */
	token: string;
	/** Mode name or id (default: the collection's default mode). */
	mode?: string;
}

/** Resolves `$token` references in profiles (see `createTokenStyleSource` in `@pixerate/editor/tokens`). */
export interface StyleTokenSource {
	/** The value, or an error saying why the reference does not resolve. */
	resolve(ref: StyleTokenRef): { ok: true; value: string | number | boolean } | { ok: false; message: string };
	subscribe?(listener: () => void): () => void;
}

export interface StyleIssue {
	/** Skill the issue is about (absent for layer-wide issues). */
	skill?: string;
	layer?: string;
	message: string;
}

/** A style skill as a resolver lists it. */
export interface StyleSkillInfo {
	name: string;
	description: string;
	/** The layer whose copy is used. */
	layer: string;
	/** Domains it applies to (every registered domain when its frontmatter names none). */
	domains: string[];
	/** Domains it has a profile for. */
	profiles: string[];
	enabled: boolean;
	order: number;
	/** Why it, or part of it, is left out. A skill with issues and no usable part is not applied. */
	issues: string[];
}

/** A skill's prose as it applies to one domain. */
export interface ResolvedStyleSkill {
	name: string;
	description: string;
	layer: string;
	/** The `SKILL.md` body (without frontmatter). */
	body: string;
}

/** Everything that applies to one domain, merged. */
export interface ResolvedStyle {
	domain: string;
	/** Applicable skills, general to specific. */
	skills: ResolvedStyleSkill[];
	/** The merged profile, with `$token` references replaced by their values. */
	profile: Record<string, unknown>;
	/** Which layer set each profile field (`palette`, `theme.fontFamily`). */
	sources: Record<string, string>;
	issues: StyleIssue[];
}

/** The result of running a domain's checks. */
export interface StyleCheckReport {
	findings: StyleFinding[];
	/** Checks that ran. */
	ran: string[];
	/** Checks the profile asked for that could not run, with the reason. */
	skipped: { check: string; reason: string }[];
}

export interface StyleResolverOptions {
	/** Layers from general to specific. */
	layers: readonly StyleLayer[];
	/** Domains style skills may target. */
	domains: readonly StyleDomain<any>[];
	/** Resolves `$token` references; without it a profile with one is reported as an issue. */
	tokens?: StyleTokenSource;
}

/** Merges house-style layers per domain. Build it with {@link createStyleResolver}. */
export interface StyleResolver {
	readonly layers: readonly StyleLayer[];
	readonly domains: readonly StyleDomain<any>[];
	/** Every style skill across layers (switched-off ones too), general to specific. */
	list(options?: { domain?: string }): Promise<StyleSkillInfo[]>;
	/** The resolved style for a domain. Throws for an unknown domain. */
	resolve(domain: string): Promise<ResolvedStyle>;
	/** A file of the skill copy in use. */
	readFile(name: string, file: string): Promise<string | undefined>;
	/** Files of the skill copy in use (`undefined` for an unknown skill). */
	files(name: string): Promise<string[] | undefined>;
	/** Runs the domain's checks that the resolved profile turns on against `state`. */
	check<State>(domain: string, state: State): Promise<StyleCheckReport & { style: ResolvedStyle }>;
	/** Called when a store or the token source changes; returns an unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

const STYLE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `domains` frontmatter field: `[chart, tokens]`, `chart, tokens` or one name. */
export function parseStyleDomains(markdown: string): string[] | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const line = match?.[1].split(/\r?\n/).find((l) => /^domains:/.test(l));
	if (!line) return undefined;
	const raw = line.slice('domains:'.length).trim().replace(/^\[|\]$/g, '');
	return raw
		.split(',')
		.map((d) => d.trim().replace(/^(['"])(.*)\1$/, '$2'))
		.filter(Boolean);
}

/**
 * A style store in memory, from skill files keyed `<skill>/<file>` (the {@link SkillFiles}
 * shape), with optional state per skill. `set`, `remove` and `setState` notify subscribers.
 */
export function memoryStyleStore(
	initial: SkillFiles = {},
	state: Readonly<Record<string, StyleSkillState>> = {}
): StyleStore & {
	set(name: string, files: Readonly<Record<string, string>>): void;
	remove(name: string): void;
	setState(name: string, state: StyleSkillState | undefined): void;
} {
	const files = new Map<string, Map<string, string>>();
	const states = new Map<string, StyleSkillState>(Object.entries(state));
	const listeners = new Set<() => void>();
	const notify = () => listeners.forEach((l) => l());
	for (const [path, text] of Object.entries(initial)) {
		const [dir, ...rest] = path.replace(/\\/g, '/').replace(/^\.?\//, '').split('/');
		if (!dir || !rest.length) continue;
		if (!files.has(dir)) files.set(dir, new Map());
		files.get(dir)!.set(rest.join('/'), text);
	}
	return {
		list: () => [...new Set([...files.keys(), ...states.keys()])].sort().map((name) => ({ name, ...states.get(name) })),
		read: (name, file) => files.get(name)?.get(file),
		files: (name) => [...(files.get(name)?.keys() ?? [])].sort(),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(name, skillFiles) {
			files.set(name, new Map(Object.entries(skillFiles)));
			notify();
		},
		remove(name) {
			files.delete(name);
			states.delete(name);
			notify();
		},
		setState(name, next) {
			if (next) states.set(name, next);
			else states.delete(name);
			notify();
		}
	};
}

interface LoadedSkill {
	info: StyleSkillInfo;
	layerIndex: number;
	body: string;
	/** Parsed, token-resolved profiles by domain. */
	profiles: Map<string, Record<string, unknown>>;
	/** Domains the skill applies to, after its issues. */
	applies: Set<string>;
}

/** Replaces `{ "$token": ... }` objects with their values. */
function resolveTokens(value: unknown, tokens: StyleTokenSource | undefined, path: string, errors: string[]): unknown {
	if (Array.isArray(value)) return value.map((v, i) => resolveTokens(v, tokens, `${path}[${i}]`, errors));
	if (!isPlainObject(value)) return value;
	if ('$token' in value) {
		const token = value.$token;
		const mode = value.mode;
		if (typeof token !== 'string' || !token || (mode !== undefined && typeof mode !== 'string') || Object.keys(value).some((k) => k !== '$token' && k !== 'mode')) {
			errors.push(`${path || 'profile'}: a token reference is { "$token": "<variable name or id>", "mode"?: "<mode>" }.`);
			return undefined;
		}
		if (!tokens) {
			errors.push(`${path}: "${token}" is a token reference, but this host has no design tokens to resolve it.`);
			return undefined;
		}
		const resolved = tokens.resolve({ token, ...(mode ? { mode } : {}) });
		if (!resolved.ok) errors.push(`${path}: ${resolved.message}`);
		return resolved.ok ? resolved.value : undefined;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = resolveTokens(v, tokens, path ? `${path}.${k}` : k, errors);
	return out;
}

/** Problems with a profile's `checks` list, against the domain's checks. */
function checkListErrors(list: unknown, domain: StyleDomain<any>): string[] {
	if (list === undefined) return [];
	if (!Array.isArray(list)) return ['checks: expected a list of check ids or { "id": ..., options } objects.'];
	const errors: string[] = [];
	list.forEach((entry, i) => {
		const id = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.id : undefined;
		if (typeof id !== 'string' || !id) {
			errors.push(`checks[${i}]: expected a check id or { "id": ..., options }.`);
			return;
		}
		const check = domain.checks.find((c) => c.id === id);
		if (!check || typeof entry === 'string') return; // unknown ids are reported as skipped when checks run
		const { id: _id, ...options } = entry as Record<string, unknown>;
		const schema = check.optionsSchema ?? { type: 'object', properties: {}, additionalProperties: false };
		for (const e of validateJsonSchema(options, schema)) errors.push(`checks[${i}] (${id})${e.path}: ${e.message}`);
	});
	return errors;
}

/** Merges `value` into `target` at `path`, recording sources and refusing locked fields. */
function mergeProfile(
	target: Record<string, unknown>,
	value: Record<string, unknown>,
	layer: StyleLayer,
	skill: string,
	sources: Record<string, string>,
	locked: Map<string, string>,
	issues: StyleIssue[],
	prefix = ''
) {
	for (const [key, next] of Object.entries(value)) {
		if (isUnsafeJsonKey(key) || next === undefined) continue;
		const path = prefix ? `${prefix}.${key}` : key;
		const lockedBy = [...locked.entries()].find(([p]) => p === path || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));
		if (isPlainObject(next)) {
			// Objects merge field by field, so sources and locks are per field.
			if (!isPlainObject(target[key])) {
				if (lockedBy && lockedBy[1] !== layer.id && target[key] !== undefined) {
					issues.push({ skill, layer: layer.id, message: `"${path}" is locked by the ${lockedBy[1]} layer, so this skill's value is ignored.` });
					continue;
				}
				target[key] = {};
				delete sources[path];
			}
			mergeProfile(target[key] as Record<string, unknown>, next, layer, skill, sources, locked, issues, path);
			continue;
		}
		if (lockedBy && lockedBy[1] !== layer.id) {
			issues.push({ skill, layer: layer.id, message: `"${path}" is locked by the ${lockedBy[1]} layer, so this skill's value is ignored.` });
			continue;
		}
		target[key] = Array.isArray(next) ? structuredClone(next) : next;
		for (const p of Object.keys(sources)) if (p.startsWith(`${path}.`)) delete sources[p];
		sources[path] = layer.id;
		if (layer.locked) locked.set(path, layer.id);
	}
}

/**
 * Builds a {@link StyleResolver} over layers of style skills. Reads go to the stores on every
 * call, so a host's change shows up at once; `subscribe` tells open views to refresh.
 */
export function createStyleResolver(options: StyleResolverOptions): StyleResolver {
	const layers = [...options.layers];
	const domains = [...options.domains];
	const ids = new Set<string>();
	for (const layer of layers) {
		if (ids.has(layer.id)) throw new Error(`Two style layers are called "${layer.id}"; give each layer its own id.`);
		ids.add(layer.id);
	}
	const domainIds = domains.map((d) => d.id);
	const requireDomain = (id: string) => {
		const domain = domains.find((d) => d.id === id);
		if (!domain) throw new Error(`There is no house-style domain "${id}"; expected one of ${domainIds.map((d) => `"${d}"`).join(', ') || '(none registered)'}.`);
		return domain;
	};

	/** The copy in use for each skill name, and every skill's info. */
	async function load(): Promise<{ skills: LoadedSkill[]; issues: StyleIssue[] }> {
		const issues: StyleIssue[] = [];
		const entries = await Promise.all(layers.map(async (layer) => [...(await layer.store.list())]));
		const names = [...new Set(entries.flat().map((e) => e.name))];
		const skills: LoadedSkill[] = [];
		for (const name of names) {
			if (!STYLE_SKILL_NAME.test(name)) {
				issues.push({ skill: name, message: `"${name}" is not a valid skill name (lowercase letters, digits and hyphens, at most 64).` });
				continue;
			}
			const copies: { index: number; text: string }[] = [];
			for (let i = 0; i < layers.length; i++) {
				const text = await layers[i].store.read(name, 'SKILL.md');
				if (text !== undefined) copies.push({ index: i, text });
			}
			if (!copies.length) continue; // state only, for a skill no layer holds
			const lockedCopy = copies.find((c) => layers[c.index].locked);
			const winner = lockedCopy ?? copies[copies.length - 1];
			const layer = layers[winner.index];
			const skillIssues: string[] = [];
			for (const c of copies) {
				if (c.index > winner.index) skillIssues.push(`The ${layers[c.index].id} layer's copy is ignored: the ${layer.id} layer is locked.`);
			}
			// State: general to specific; a required layer's skills keep their own state only.
			let enabled = true;
			let order = 0;
			for (let i = 0; i < layers.length; i++) {
				const entry = entries[i].find((e) => e.name === name);
				if (!entry) continue;
				if (i === winner.index && entry.order !== undefined) order = entry.order;
				if (entry.enabled === undefined) continue;
				if (layer.required && i !== winner.index) {
					if (entry.enabled === false) skillIssues.push(`The ${layers[i].id} layer cannot switch it off: the ${layer.id} layer requires it.`);
					continue;
				}
				enabled = entry.enabled;
			}
			const { description = '', body } = parseSkillFrontmatter(winner.text);
			const named = parseStyleDomains(winner.text);
			const applies = new Set<string>();
			for (const d of named ?? domainIds) {
				if (domainIds.includes(d)) applies.add(d);
				else skillIssues.push(`It names an unknown domain "${d}"; the domains here are ${domainIds.join(', ')}.`);
			}
			const profiles = new Map<string, Record<string, unknown>>();
			for (const domain of domains) {
				const raw = await layer.store.read(name, `${domain.id}.json`);
				if (raw === undefined) continue;
				const file = `${domain.id}.json`;
				if (!applies.has(domain.id)) {
					skillIssues.push(`${file} is left out: the skill's domains do not include ${domain.id}.`);
					continue;
				}
				let parsed: unknown;
				try {
					parsed = stripPrototypeKeys(JSON.parse(raw));
				} catch (error) {
					skillIssues.push(`${file} is not valid JSON: ${(error as Error).message}`);
					continue;
				}
				if (!isPlainObject(parsed)) {
					skillIssues.push(`${file} must hold a JSON object.`);
					continue;
				}
				const errors: string[] = [];
				const resolved = resolveTokens(parsed, options.tokens, '', errors) as Record<string, unknown>;
				const { checks, ...rest } = resolved;
				errors.push(...validateJsonSchema(rest, domain.profileSchema).map((e) => `${e.path || '(profile)'}: ${e.message}`));
				errors.push(...checkListErrors(checks, domain));
				if (errors.length) {
					skillIssues.push(`${file} is left out: ${errors.join(' ')}`);
					continue;
				}
				profiles.set(domain.id, resolved);
			}
			skills.push({
				info: {
					name,
					description,
					layer: layer.id,
					domains: [...applies],
					profiles: [...profiles.keys()],
					enabled,
					order,
					issues: skillIssues
				},
				layerIndex: winner.index,
				body: body.trim(),
				profiles,
				applies
			});
		}
		skills.sort((a, b) => a.layerIndex - b.layerIndex || a.info.order - b.info.order || a.info.name.localeCompare(b.info.name));
		return { skills, issues };
	}

	async function resolve(domainId: string): Promise<ResolvedStyle> {
		requireDomain(domainId);
		const { skills, issues: loadIssues } = await load();
		const issues: StyleIssue[] = [...loadIssues];
		const profile: Record<string, unknown> = {};
		const sources: Record<string, string> = {};
		const locked = new Map<string, string>();
		const applied: ResolvedStyleSkill[] = [];
		for (const skill of skills) {
			if (!skill.applies.has(domainId)) continue;
			for (const message of skill.info.issues) issues.push({ skill: skill.info.name, layer: skill.info.layer, message });
			if (!skill.info.enabled) continue;
			applied.push({ name: skill.info.name, description: skill.info.description, layer: skill.info.layer, body: skill.body });
			const own = skill.profiles.get(domainId);
			if (own) mergeProfile(profile, own, layers[skill.layerIndex], skill.info.name, sources, locked, issues);
		}
		return { domain: domainId, skills: applied, profile, sources, issues };
	}

	async function winnerLayer(name: string): Promise<StyleLayer | undefined> {
		const copies: number[] = [];
		for (let i = 0; i < layers.length; i++) if ((await layers[i].store.read(name, 'SKILL.md')) !== undefined) copies.push(i);
		if (!copies.length) return undefined;
		return layers[copies.find((i) => layers[i].locked) ?? copies[copies.length - 1]];
	}

	return {
		layers,
		domains,
		async list(opts = {}) {
			if (opts.domain !== undefined) requireDomain(opts.domain);
			const { skills } = await load();
			return skills.filter((s) => opts.domain === undefined || s.applies.has(opts.domain)).map((s) => s.info);
		},
		resolve,
		async readFile(name, file) {
			const layer = await winnerLayer(name);
			return layer ? layer.store.read(name, file) : undefined;
		},
		async files(name) {
			const layer = await winnerLayer(name);
			return layer ? [...(await layer.store.files(name))] : undefined;
		},
		async check(domainId, state) {
			const domain = requireDomain(domainId);
			const style = await resolve(domainId);
			return { ...runStyleChecks(domain, state, style), style };
		},
		subscribe(listener) {
			const offs = [...layers.map((l) => l.store.subscribe?.(listener)), options.tokens?.subscribe?.(listener)];
			return () => offs.forEach((off) => off?.());
		}
	};
}

/** Runs the checks a resolved profile turns on. A check that is unknown or throws is skipped with the reason. */
export function runStyleChecks<State>(domain: StyleDomain<State>, state: State, style: ResolvedStyle): StyleCheckReport {
	const report: StyleCheckReport = { findings: [], ran: [], skipped: [] };
	const list = Array.isArray(style.profile.checks) ? style.profile.checks : [];
	const layer = style.sources.checks;
	for (const entry of list) {
		const id = typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : undefined;
		if (!id) continue;
		const check = domain.checks.find((c) => c.id === id);
		if (!check) {
			report.skipped.push({ check: id, reason: `There is no "${id}" check for ${domain.id}; it has ${domain.checks.map((c) => `"${c.id}"`).join(', ')}.` });
			continue;
		}
		const { id: _id, ...options } = isPlainObject(entry) ? entry : { id };
		try {
			for (const f of check.run(state, style.profile, options)) report.findings.push({ ...f, check: id, ...(layer ? { layer } : {}) });
			report.ran.push(id);
		} catch (error) {
			report.skipped.push({ check: id, reason: `The check could not run: ${(error as Error).message}` });
		}
	}
	return report;
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A resolved style as text for a model: one `<style_skill>` block per skill (naming its layer;
 * text that tries to open or close a block is escaped) and the merged profile as JSON.
 */
export function renderStyle(style: ResolvedStyle): string {
	if (!style.skills.length) return `No house style applies to ${style.domain}.`;
	const blocks = style.skills.map((s) => {
		const body = s.body.replace(/<(\/?)style_skill/gi, '&lt;$1style_skill');
		return `<style_skill name="${escapeAttribute(s.name)}" layer="${escapeAttribute(s.layer)}">\n${body}\n</style_skill>`;
	});
	const profile = Object.keys(style.profile).length ? `\n\nMerged ${style.domain} profile:\n${JSON.stringify(style.profile, null, 2)}` : '';
	return `${blocks.join('\n\n')}${profile}`;
}
