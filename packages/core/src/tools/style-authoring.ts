/**
 * Tools for people (and agents) who write house-style skills. Hosts keep owning the skills;
 * these make a skill easy to get right before it is installed:
 *
 * - `checkStyleSkill` reads a draft skill folder exactly as a resolver would and reports what
 *   is offered, what is left out and why, and the profile each domain ends up with;
 * - `styleProfileSchema` is a domain's full JSON Schema (with its `checks`), for editors;
 * - `scaffoldStyleSkill` starts a skill from the domains' example profiles;
 * - `renderStylePreview` draws a report as an HTML page (the `pixerate-style preview` command).
 *
 * Dependency-free.
 */
import type { JsonSchema } from './schema.js';
import { parseFrontmatter } from './yaml.js';
import { brandColors, brandPalette, brandFonts, type BrandProfile } from './brand.js';
import {
	DEFAULT_STYLE_LIMITS,
	MAX_STYLE_INHERITANCE_DEPTH,
	STYLE_SKILL_NAME,
	brandStyleDomain,
	styleFilePathProblem,
	type StyleLimits,
	type StyleProfileMigration,
	createStyleResolver,
	memoryStyleStore,
	parseStyleDomains,
	styleChecksOf,
	type StyleDomain,
	type StyleResolver,
	type StyleTokenSource
} from './style.js';

/** One file of a draft style skill, and what a resolver does with it. */
export interface StyleSkillFileReport {
	path: string;
	/** UTF-8 size. */
	bytes: number;
	/**
	 * `skill` (SKILL.md), `profile` (`<domain>.json` for a domain here), `reference` (read on
	 * demand) or `left-out` (outside the limits; the reason is in warnings or errors).
	 */
	role: 'skill' | 'profile' | 'reference' | 'left-out';
}

/** What `checkStyleSkill` found. */
export interface StyleSkillReport {
	name: string;
	/** A resolver offers the skill and leaves none of it out. Warnings do not count. */
	ok: boolean;
	/** The frontmatter, when SKILL.md has one. */
	manifest?: { name?: string; description?: string; domains?: string[] };
	/** The domains the skill applies to. */
	domains: string[];
	files: StyleSkillFileReport[];
	/** The profile each domain gets from this skill alone (brand-derived fields included). */
	profiles: Record<string, Record<string, unknown>>;
	/** The brand it carries, after `$token` references are resolved. */
	brand?: BrandProfile;
	/** What stops the skill, or part of it, from being used. */
	errors: string[];
	/** What loads but is probably a mistake. */
	warnings: string[];
	/** The skills its profiles build on (`extends`), nearest first. */
	inherits?: string[];
	/** Profiles in an older format, as they read after upgrading (save these to stop upgrading on every read). */
	migrations?: StyleProfileMigration[];
}

export interface CheckStyleSkillOptions {
	/** The domains the host registers (the brand domain is always added). */
	domains: readonly StyleDomain<any>[];
	/** Resolves `$token` references; without it each reference is an error, as in a host without tokens. */
	tokens?: StyleTokenSource;
	/** The host's file limits (default {@link DEFAULT_STYLE_LIMITS}). */
	limits?: Partial<StyleLimits>;
	/**
	 * Where the skills a draft `extends` are read from (a host's resolver). Without it, a draft with
	 * a base is checked as if the base were missing.
	 */
	bases?: Pick<StyleResolver, 'files' | 'readFile'>;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** A SKILL.md's `extends` base, if it names one. */
function extendsOf(skillText: string): string | undefined {
	const fm = parseFrontmatter(skillText);
	const value = fm.error ? undefined : fm.data.extends;
	return typeof value === 'string' && STYLE_SKILL_NAME.test(value) ? value : undefined;
}
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.?\//, '');

/**
 * Reads a draft style skill (`files` keyed by path inside its folder: `SKILL.md`, `chart.json`,
 * `references/tone.md`) the way `createStyleResolver` will, and reports the result.
 */
export async function checkStyleSkill(name: string, files: Readonly<Record<string, string>>, options: CheckStyleSkillOptions): Promise<StyleSkillReport> {
	const domains = options.domains.some((d) => d.id === brandStyleDomain.id) ? [...options.domains] : [...options.domains, brandStyleDomain];
	const domainIds = domains.map((d) => d.id);
	const limits: StyleLimits = { ...DEFAULT_STYLE_LIMITS, ...options.limits };
	const report: StyleSkillReport = { name, ok: false, domains: [], files: [], profiles: {}, errors: [], warnings: [] };
	const entries = Object.entries(files).map(([path, text]) => [normalize(path), text] as const);
	const total = entries.reduce((n, [, t]) => n + byteLength(t), 0);
	if (total > limits.maxSkillBytes) report.errors.push(`The skill is ${Math.round(total / 1024)} KB, over the ${Math.round(limits.maxSkillBytes / 1024)} KB limit; move long references out or shorten them.`);
	if (entries.length > limits.maxFiles) report.errors.push(`The skill has ${entries.length} files; a host offers at most ${limits.maxFiles}.`);
	for (const [path, text] of entries.sort(([a], [b]) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a < b ? -1 : a > b ? 1 : 0))) {
		const profile = /^([a-z0-9-]+)\.json$/.exec(path)?.[1];
		const bytes = byteLength(text);
		const problem = path === 'SKILL.md' ? undefined : styleFilePathProblem(path, limits);
		const tooBig = bytes > limits.maxFileBytes;
		const role = problem || tooBig ? 'left-out' : path === 'SKILL.md' ? 'skill' : profile && domainIds.includes(profile) ? 'profile' : 'reference';
		report.files.push({ path, bytes, role });
		if (problem) report.warnings.push(`${path} is left out: ${problem}`);
		else if (tooBig && !(path === 'SKILL.md' || (profile && domainIds.includes(profile)))) report.warnings.push(`${path} is left out: it is ${Math.round(bytes / 1024)} KB, over the ${Math.round(limits.maxFileBytes / 1024)} KB limit.`);
		if (role === 'reference' && profile) {
			report.warnings.push(`${path} is not a profile for any domain here (${domainIds.join(', ')}); agents can still read it with get_style_file.`);
		}
	}
	if (!STYLE_SKILL_NAME.test(name)) report.errors.push(`"${name}" is not a valid skill name: use lowercase letters, digits and hyphens, at most 64, as the folder name.`);
	const skillText = files['SKILL.md'] ?? entries.find(([p]) => p === 'SKILL.md')?.[1];
	if (skillText === undefined) {
		report.errors.push('There is no SKILL.md; a store does not offer a folder without one.');
		return report;
	}
	const fm = parseFrontmatter(skillText);
	const front = { name: typeof fm.data.name === 'string' ? fm.data.name : undefined, description: typeof fm.data.description === 'string' ? fm.data.description : undefined, body: fm.body };
	if (!fm.present) report.errors.push('SKILL.md has no frontmatter; start it with ---, name, description and an optional domains list, then ---.');
	else if (!fm.error) {
		const named = parseStyleDomains(skillText);
		report.manifest = { ...(front.name ? { name: front.name } : {}), ...(front.description ? { description: front.description } : {}), ...(named ? { domains: named } : {}) };
		if (!front.name) report.warnings.push('SKILL.md has no name; use the folder name.');
		else if (front.name !== name) report.warnings.push(`SKILL.md is named "${front.name}" but its folder is "${name}"; the folder name is what hosts and agents use.`);
		if (!front.description) report.warnings.push('SKILL.md has no description; say what the style is for and when it applies, in one or two sentences.');
	}
	if (!front.body.trim()) report.warnings.push('SKILL.md has no body; write the preferences an agent should follow, and name the files it should read.');
	if (!STYLE_SKILL_NAME.test(name)) return report;

	const store = memoryStyleStore(Object.fromEntries(entries.map(([path, text]) => [`${name}/${path}`, text])));
	// The draft's bases, switched off so they serve as bases only and the profiles stay this skill's.
	const baseFiles: Record<string, string> = {};
	const baseState: Record<string, { enabled: false }> = {};
	for (let base = extendsOf(skillText), depth = 0; base && options.bases && depth <= MAX_STYLE_INHERITANCE_DEPTH && base !== name && !baseState[base]; depth++) {
		const paths = await options.bases.files(base);
		if (!paths) break;
		let baseSkill = '';
		for (const path of paths) {
			const text = await options.bases.readFile(base, path);
			if (text === undefined) continue;
			baseFiles[`${base}/${path}`] = text;
			if (path === 'SKILL.md') baseSkill = text;
		}
		baseState[base] = { enabled: false };
		base = extendsOf(baseSkill);
	}
	const draftLayers = Object.keys(baseState).length ? [{ id: 'bases', store: memoryStyleStore(baseFiles, baseState) }, { id: 'draft', store }] : [{ id: 'draft', store }];
	const resolver = createStyleResolver({ layers: draftLayers, domains, limits, ...(options.tokens ? { tokens: options.tokens } : {}) });
	const info = (await resolver.list()).find((s) => s.name === name);
	if (!info) {
		for (const issue of (await resolver.resolve(brandStyleDomain.id)).issues) report.errors.push(issue.message);
		if (!report.errors.length) report.errors.push('A store would not offer this skill.');
		return report;
	}
	report.domains = info.domains;
	report.errors.push(...info.issues);
	if (info.inherits) report.inherits = info.inherits;
	if (info.migrations) {
		report.migrations = info.migrations;
		for (const m of info.migrations) report.warnings.push(`${m.file === 'frontmatter' ? `The frontmatter "${m.domain}" profile` : m.file} is version ${m.from} and is upgraded to version ${m.to} each time it is read; save the upgraded profile (in migrations) to stop that.`);
	}
	for (const domain of info.domains) {
		const style = await resolver.resolve(domain);
		if (domain === brandStyleDomain.id) {
			if (Object.keys(style.profile).length) report.brand = style.profile as BrandProfile;
			continue;
		}
		for (const issue of style.issues) if ((!issue.skill || issue.skill === name) && !report.errors.includes(issue.message) && !info.issues.includes(issue.message)) report.errors.push(issue.message);
		if (Object.keys(style.profile).length) report.profiles[domain] = style.profile;
	}
	if (!info.profiles.length && !front.body.trim()) report.warnings.push('The skill has neither preferences nor a profile, so it changes nothing.');
	report.ok = report.errors.length === 0;
	return report;
}

/**
 * A domain's profile as a standalone JSON Schema (draft 2020-12) with its `checks` list, for
 * editor completion (`"$schema": "./chart.schema.json"`) and validation outside the library.
 */
export function styleProfileSchema(domain: StyleDomain<any>): JsonSchema & Record<string, unknown> {
	const checks = styleChecksOf(domain);
	const properties = { ...((domain.profileSchema as { properties?: Record<string, JsonSchema> }).properties ?? {}) };
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		title: `${domain.title} house-style profile (${domain.id}.json)`,
		description: domain.description,
		type: 'object',
		properties: {
			$schema: { type: 'string', description: 'Path or URL of this schema, for editors. Ignored when the profile loads.' },
			...(domain.profileVersion !== undefined ? { version: { type: 'integer', minimum: 1, maximum: domain.profileVersion, description: `The profile format this file is written for (current: ${domain.profileVersion}; missing means 1). Older ones are upgraded when read.` } } : {}),
			...properties,
			...(checks.length
				? {
						checks: {
							type: 'array',
							description: 'Checks to run in check_<domain>_style: an id, or an object with the id and its options.',
							items: {
								anyOf: [
									{ type: 'string', enum: checks.map((c) => c.id), description: checks.map((c) => `${c.id}: ${c.description}`).join('\n') },
									...checks.map((c) => ({
										type: 'object',
										description: c.description,
										properties: { id: { const: c.id }, ...((c.optionsSchema as { properties?: Record<string, JsonSchema> })?.properties ?? {}) },
										required: ['id'],
										additionalProperties: false
									}))
								]
							}
						}
					}
				: {})
		},
		additionalProperties: false
	} as JsonSchema & Record<string, unknown>;
}

export interface ScaffoldStyleSkillOptions {
	/** Folder name. */
	name: string;
	/** What the style is for and when it applies. */
	description?: string;
	/** Domains to write an example profile for (`brand`, `chart`, ...); each needs an `example`. */
	profiles: readonly string[];
	/** The domains the host registers (the brand domain is always added). */
	domains: readonly StyleDomain<any>[];
	/** Name the domains in frontmatter (default: no list, so the skill applies everywhere). */
	limitDomains?: boolean;
}

/** A new style skill's files: SKILL.md with frontmatter and a body to edit, and example profiles. */
export function scaffoldStyleSkill(options: ScaffoldStyleSkillOptions): Record<string, string> {
	if (!STYLE_SKILL_NAME.test(options.name)) throw new Error(`"${options.name}" is not a valid skill name: use lowercase letters, digits and hyphens, at most 64.`);
	const domains = options.domains.some((d) => d.id === brandStyleDomain.id) ? [...options.domains] : [...options.domains, brandStyleDomain];
	const files: Record<string, string> = {};
	for (const id of options.profiles) {
		const domain = domains.find((d) => d.id === id);
		if (!domain) throw new Error(`There is no domain "${id}"; the domains here are ${domains.map((d) => `"${d.id}"`).join(', ')}.`);
		if (!domain.example) throw new Error(`The ${id} domain has no example profile to start from; write ${id}.json from get_style_schema.`);
		files[`${id}.json`] = `${JSON.stringify(domain.profileVersion !== undefined ? { version: domain.profileVersion, ...domain.example } : domain.example, null, 2)}\n`;
	}
	const listed = options.limitDomains ? options.profiles.filter((d) => d !== brandStyleDomain.id) : [];
	const description = options.description ?? `${options.name} house style. Use when making or changing ${listed.length ? listed.join(' and ') : 'anything'}.`;
	files['SKILL.md'] = [
		'---',
		`name: ${options.name}`,
		`description: ${description.replace(/\n/g, ' ')}`,
		...(listed.length ? [`domains: [${listed.join(', ')}]`] : []),
		'---',
		'',
		`# ${options.name}`,
		'',
		'Write the preferences an agent should follow here: what good looks like, what to avoid, and',
		'which files of this folder to read and when. Keep structured rules (colours, fonts, checks) in',
		'the profiles beside this file so they can be checked.',
		''
	].join('\n');
	return files;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const swatch = (label: string, color: string) =>
	`<figure class="swatch"><span style="background:${escapeHtml(color)}"></span><figcaption>${escapeHtml(label)}<br><code>${escapeHtml(color)}</code></figcaption></figure>`;

/**
 * A report as an HTML page: errors and warnings, the brand (role colours, palette, fonts, logo),
 * and each domain's profile with a sample drawn in it (`StyleDomain.preview`). The page loads
 * nothing and runs no script of the skill's; the logo is shown as an image.
 */
export function renderStylePreview(
	report: StyleSkillReport,
	domains: readonly StyleDomain<any>[],
	options: {
		/** Load `/reload.js` from the page's own server (live reload). */
		reload?: boolean;
	} = {}
): string {
	const parts: string[] = [];
	parts.push(`<header><h1>${escapeHtml(report.manifest?.name ?? report.name)}</h1><p class="${report.ok ? 'ok' : 'bad'}">${report.ok ? 'Ready: a host would offer every part of this skill.' : 'Not ready: fix the errors below.'}</p>${report.manifest?.description ? `<p>${escapeHtml(report.manifest.description)}</p>` : ''}</header>`);
	if (report.errors.length) parts.push(`<section><h2>Errors</h2><ul class="bad">${report.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></section>`);
	if (report.warnings.length) parts.push(`<section><h2>Warnings</h2><ul class="warn">${report.warnings.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></section>`);
	const brand = report.brand;
	if (brand) {
		const roles = Object.entries(brandColors(brand));
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		parts.push(
			`<section><h2>Brand${brand.name ? `: ${escapeHtml(brand.name)}` : ''}</h2>` +
				(roles.length ? `<h3>Roles</h3><div class="swatches">${roles.map(([role, c]) => swatch(role, c)).join('')}</div>` : '') +
				(palette.length ? `<h3>Palette</h3><div class="swatches">${palette.map((c, i) => swatch(String(i + 1), c)).join('')}</div>` : '') +
				(fonts.length ? `<h3>Fonts</h3>${fonts.map((f) => `<p style="font-family:${escapeHtml(JSON.stringify(f))}, sans-serif;font-size:20px">${escapeHtml(f)}: The quick brown fox jumps over the lazy dog</p>`).join('')}` : '') +
				(brand.logo?.svg ? `<h3>Logo</h3><img class="logo" alt="Logo" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(brand.logo.svg)}">` : '') +
				'</section>'
		);
	}
	for (const [id, profile] of Object.entries(report.profiles)) {
		const domain = domains.find((d) => d.id === id);
		let sample = '';
		if (domain?.preview) {
			try {
				sample = `<div class="sample">${domain.preview(profile, brand)}</div>`;
			} catch (error) {
				sample = `<p class="bad">The sample could not be drawn: ${escapeHtml((error as Error).message)}</p>`;
			}
		}
		parts.push(`<section><h2>${escapeHtml(domain?.title ?? id)} <small>${escapeHtml(id)}.json</small></h2>${sample}<details><summary>Merged profile</summary><pre>${escapeHtml(JSON.stringify(profile, null, 2))}</pre></details></section>`);
	}
	parts.push(`<section><h2>Files</h2><table>${report.files.map((f) => `<tr><td><code>${escapeHtml(f.path)}</code></td><td>${f.role}</td><td>${f.bytes} B</td></tr>`).join('')}</table></section>`);
	const style = `body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;color:#1a1a1a;background:#fff}h1{margin:0}small{color:#666;font-weight:normal}.ok{color:#11753a}.bad{color:#b3261e}.warn{color:#8a5a00}.swatches{display:flex;flex-wrap:wrap;gap:12px}.swatch{margin:0;width:96px}.swatch span{display:block;height:48px;border-radius:6px;border:1px solid #0002}.swatch figcaption{font-size:12px}.logo{max-width:240px;max-height:120px}.sample{overflow:auto;border:1px solid #ddd;border-radius:6px;padding:8px}pre{overflow:auto;background:#f6f6f6;padding:8px}td{padding:2px 12px 2px 0}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}pre{background:#222}}`;
	const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'${options.reload ? "; script-src 'self'; connect-src 'self'" : ''}`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(report.name)} · house style</title><style>${style}</style>${options.reload ? '<script src="/reload.js"></script>' : ''}</head><body>${parts.join('')}</body></html>`;
}

/** What `saveStyleSkill` did. */
export interface SavedStyleSkill {
	name: string;
	/** The layer written. */
	layer: string;
	/** The skill's files after the save. */
	files: string[];
	/** Whether the skill was new in that layer. */
	created: boolean;
	/** The domains it applies to, and the profile each gets from it. */
	domains: string[];
	profiles: Record<string, Record<string, unknown>>;
	/** Loads, but probably a mistake. */
	warnings: string[];
	/** The skills its profiles build on (`extends`), nearest first. */
	inherits?: string[];
}

const writableLayer = (styles: StyleResolver, verb: 'save' | 'remove', layer?: string) => {
	const writable = styles.layers.filter((l) => (verb === 'save' ? l.store.save : l.store.remove));
	const target = layer !== undefined ? styles.layers.find((l) => l.id === layer) : writable[writable.length - 1];
	if (!target) {
		throw new Error(layer !== undefined ? `There is no layer "${layer}"; the layers are ${styles.layers.map((l) => `"${l.id}"`).join(', ')}.` : 'Every style store here is read-only, so skills cannot be saved or removed.');
	}
	if (!(verb === 'save' ? target.store.save : target.store.remove)) {
		throw new Error(`The ${target.id} layer is read-only; use one of ${writable.map((l) => `"${l.id}"`).join(', ') || '(none: every style store is read-only)'}.`);
	}
	return target;
};

/**
 * Saves a house-style skill to a writable layer (default: the most specific one), after
 * checking it exactly as the resolver will load it. With `replace`, the given files become the
 * whole skill; otherwise they are merged over the layer's copy, so editing `SKILL.md` keeps the
 * profiles. Writes nothing and throws with every error when the result would not load cleanly,
 * or when an earlier locked layer holds the skill (a copy here would be ignored).
 */
export async function saveStyleSkill(styles: StyleResolver, name: string, files: Readonly<Record<string, string>>, options: { layer?: string; replace?: boolean } = {}): Promise<SavedStyleSkill> {
	if (!STYLE_SKILL_NAME.test(name)) throw new Error(`"${name}" is not a valid skill name: use lowercase letters, digits and hyphens, at most 64.`);
	const target = writableLayer(styles, 'save', options.layer);
	const index = styles.layers.indexOf(target);
	for (const l of styles.layers.slice(0, index)) {
		if (l.locked && (await l.store.read(name, 'SKILL.md')) !== undefined) {
			throw new Error(`The ${l.id} layer locks "${name}", so a copy in the ${target.id} layer would be ignored; choose another name.`);
		}
	}
	const existing = (await target.store.read(name, 'SKILL.md')) !== undefined;
	const merged: Record<string, string> = {};
	if (existing && !options.replace) for (const f of await target.store.files(name)) merged[f] = (await target.store.read(name, f)) ?? '';
	for (const [f, text] of Object.entries(files)) merged[normalize(f)] = text;
	const report = await checkStyleSkill(name, merged, { domains: styles.domains, limits: styles.limits, bases: styles, ...(styles.tokens ? { tokens: styles.tokens } : {}) });
	if (!report.ok) throw new Error(`"${name}" was not saved: ${report.errors.join(' ')}`);
	await target.store.save!(name, merged, { replace: true });
	return { name, layer: target.id, files: report.files.filter((f) => f.role !== 'left-out').map((f) => f.path), created: !existing, domains: report.domains, profiles: report.profiles, warnings: report.warnings, ...(report.inherits ? { inherits: report.inherits } : {}) };
}

/**
 * Removes a skill's copy from a writable layer (default: the most specific writable layer that
 * holds it). Copies in other layers stay, and apply again if this one was in front of them.
 */
export async function removeStyleSkill(styles: StyleResolver, name: string, options: { layer?: string } = {}): Promise<{ name: string; layer: string; stillProvidedBy?: string; extendedBy?: string[] }> {
	let target;
	if (options.layer !== undefined) target = writableLayer(styles, 'remove', options.layer);
	else {
		const holders = [];
		for (const l of styles.layers) if (l.store.remove && (await l.store.read(name, 'SKILL.md')) !== undefined) holders.push(l);
		target = holders[holders.length - 1];
		if (!target) {
			const anywhere = [];
			for (const l of styles.layers) if ((await l.store.read(name, 'SKILL.md')) !== undefined) anywhere.push(l.id);
			throw new Error(anywhere.length ? `"${name}" is only in read-only layers (${anywhere.join(', ')}); switch it off with its state instead.` : `There is no house-style skill "${name}".`);
		}
	}
	if ((await target.store.read(name, 'SKILL.md')) === undefined) throw new Error(`The ${target.id} layer has no "${name}" to remove.`);
	const children = (await styles.list()).filter((s) => s.inherits?.includes(name)).map((s) => s.name);
	await target.store.remove!(name);
	let stillProvidedBy: string | undefined;
	for (const l of styles.layers) if ((await l.store.read(name, 'SKILL.md')) !== undefined) stillProvidedBy = l.id;
	// Skills built on it lose their profiles when no copy is left.
	return { name, layer: target.id, ...(stillProvidedBy ? { stillProvidedBy } : {}), ...(!stillProvidedBy && children.length ? { extendedBy: children } : {}) };
}
