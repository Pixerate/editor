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
}

/** Reads `name` and `description` from a SKILL.md's YAML frontmatter. */
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
	if (!match) return { body: markdown };
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
	}
	return { name: fields.name, description: fields.description, body: markdown.slice(match[0].length) };
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.?\//, '');

/** The skills in a set of skill files, sorted by name. */
export function listSkills(files: SkillFiles): SkillInfo[] {
	const skills = new Map<string, SkillInfo>();
	const paths = Object.keys(files).map(normalize);
	for (const path of paths) {
		const [dir, ...rest] = path.split('/');
		if (rest.join('/') !== 'SKILL.md') continue;
		const { description } = parseSkillFrontmatter(files[path] ?? files[`./${path}`] ?? '');
		skills.set(dir, { name: dir, description: description ?? '', references: [] });
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
