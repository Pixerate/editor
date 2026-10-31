/**
 * Agent skill files (`skills/<name>/SKILL.md` plus its `references/*.md`), keyed by
 * path relative to the skills directory: `pixerate-chart/SKILL.md`,
 * `pixerate-vector/references/commands.md`. In Node, `loadSkillFiles()` from
 * `@pixerate/editor/bridge` reads the ones shipped with the package; in a browser,
 * import them as text (with Vite, `import.meta.glob('…/skills/**\/*.md', { query: '?raw', import: 'default', eager: true })`).
 */
export type SkillFiles = Readonly<Record<string, string>>;

export interface SkillInfo {
	/** Skill name (its directory), e.g. `pixerate-chart`. */
	name: string;
	/** The frontmatter `description`: what the skill covers and when to use it. */
	description: string;
	/** Other files of the skill relative to its directory, e.g. `references/commands.md`. */
	references: string[];
	/**
	 * `workflow` for a skill that covers one job from start to finish on a reference skill's tools
	 * (frontmatter `metadata.kind: workflow`); otherwise `reference`.
	 */
	kind: 'reference' | 'workflow';
	/** A workflow skill's reference skill (frontmatter `metadata.reference`), whose tools it uses. */
	reference?: string;
}

/**
 * Reads `name`, `description` and the one-level `metadata` map (`metadata.kind`,
 * `metadata.reference`, …) from a SKILL.md's YAML frontmatter.
 */
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string; metadata: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
	if (!match) return { metadata: {}, body: markdown };
	const fields: Record<string, string> = {};
	const metadata: Record<string, string> = {};
	const unquote = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
	let inMetadata = false;
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (kv) {
			fields[kv[1]] = unquote(kv[2]);
			inMetadata = kv[1] === 'metadata' && kv[2].trim() === '';
			continue;
		}
		const nested = inMetadata ? /^\s+([A-Za-z_-]+):\s*(.*)$/.exec(line) : null;
		if (nested) metadata[nested[1]] = unquote(nested[2]);
	}
	return { name: fields.name, description: fields.description, metadata, body: markdown.slice(match[0].length) };
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.?\//, '');

/** The skills in a set of skill files, sorted by name. */
export function listSkills(files: SkillFiles): SkillInfo[] {
	const skills = new Map<string, SkillInfo>();
	const paths = Object.keys(files).map(normalize);
	for (const path of paths) {
		const [dir, ...rest] = path.split('/');
		if (rest.join('/') !== 'SKILL.md') continue;
		const { description, metadata } = parseSkillFrontmatter(files[path] ?? files[`./${path}`] ?? '');
		const workflow = metadata.kind === 'workflow';
		skills.set(dir, {
			name: dir,
			description: description ?? '',
			references: [],
			kind: workflow ? 'workflow' : 'reference',
			...(workflow && metadata.reference ? { reference: metadata.reference } : {}),
		});
	}
	for (const path of paths) {
		const [dir, ...rest] = path.split('/');
		const file = rest.join('/');
		if (file && file !== 'SKILL.md' && skills.has(dir)) skills.get(dir)!.references.push(file);
	}
	for (const skill of skills.values()) skill.references.sort();
	return Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** One file of a skill (`SKILL.md` by default), or `undefined` if there is none. */
export function readSkillFile(files: SkillFiles, skill: string, file = 'SKILL.md'): string | undefined {
	const path = `${skill}/${normalize(file)}`;
	return files[path] ?? files[`./${path}`];
}
