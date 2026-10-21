/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillFiles } from '../tools/skills.js';

declare const __dirname: string | undefined;

/** The `skills` directory shipped with `@pixerate/editor`, found by walking up from this module. */
export function defaultSkillsDir(): string | null {
	let dir = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		const candidate = join(dir, 'skills');
		if (existsSync(join(candidate, 'pixerate-agent-tools', 'SKILL.md'))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Reads agent skill files (every `<skill>/**\/*.md`) into the {@link SkillFiles} shape that
 * `createMcpServer({ skills })` and `registry.view({ discovery: { skills } })` take. Defaults
 * to the skills shipped with the package; returns `{}` when there are none.
 */
export function loadSkillFiles(dir: string | null = defaultSkillsDir()): SkillFiles {
	const files: Record<string, string> = {};
	if (!dir || !existsSync(dir)) return files;
	const walk = (current: string) => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.md') && current !== dir) files[relative(dir, path).split(sep).join('/')] = readFileSync(path, 'utf8');
		}
	};
	walk(dir);
	return files;
}
