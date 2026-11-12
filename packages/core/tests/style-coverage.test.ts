/**
 * House style reaches every editor (#772, epic #780). Each reference skill (one per editor
 * domain, listed in skills/README.md) maps to its `StyleDomain`, to an open issue that adds it,
 * or to the reason it has none. A new domain fails here until it is mapped, so house style is
 * never left out of a new editor by accident. The pending list is tracked debt: remove an entry
 * when its domain lands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { styleChecksOf, SHARED_STYLE_CHECKS, type StyleDomain } from '../src/tools';
import { chartStyleDomain } from '../src/chart';
import { tokensStyleDomain } from '../src/tokens';
import { richTextStyleDomain } from '../src/richTextStyle';
import { spreadsheetStyleDomain } from '../src/spreadsheet/style';
import { diagramStyleDomain } from '../src/diagram/style';
import { canvasStyleDomain } from '../src/canvas/style';
import { typographyStyleDomain } from '../src/typography/style';
import { imageStyleDomain } from '../src/image-editor/style';
import { paintStyleDomain } from '../src/paint-editor/style';
import { animationStyleDomain } from '../src/animation-editor/style';
import { videoStyleDomain } from '../src/video-editor/style';
import { generationStyleDomain } from '../src/generation/style';
import { parametersStyleDomain } from '../src/parameters/style';
import { vectorStyleDomain } from '../src/vector/style';
import { effectAuthoringStyleDomain } from '../src/effects/authoring-style';
import { stickerStyleDomain } from '../src/stickers/style';
import { brushStyleDomain } from '../src/brushes/style';

type Coverage = StyleDomain<any> | { pending: `#${number}` } | { none: string };

const COVERAGE: Record<string, Coverage> = {
	'pixerate-agent-tools': { none: 'Not an editor: the tool mechanics every domain shares.' },
	'pixerate-color': { none: 'Colour tools serve every editor; brand.json and the shared checks are its house style.' },
	'pixerate-chart': chartStyleDomain,
	'pixerate-tokens': tokensStyleDomain,
	'pixerate-rich-text': richTextStyleDomain,
	'pixerate-spreadsheet': spreadsheetStyleDomain,
	'pixerate-canvas': canvasStyleDomain,
	'pixerate-vector': vectorStyleDomain,
	'pixerate-diagram': diagramStyleDomain,
	'pixerate-image-editor': imageStyleDomain,
	'pixerate-paint-editor': paintStyleDomain,
	'pixerate-animation-editor': animationStyleDomain,
	'pixerate-video-editor': videoStyleDomain,
	'pixerate-generation': generationStyleDomain,
	'pixerate-parameters': parametersStyleDomain,
	'pixerate-effect-authoring': effectAuthoringStyleDomain,
	'pixerate-typography': typographyStyleDomain,
	'pixerate-stickers': stickerStyleDomain,
	'pixerate-brushes': brushStyleDomain
};

/** The reference skills: the first table of skills/README.md, before "## Workflow skills". */
function referenceSkills(): string[] {
	const readme = readFileSync(path.join(__dirname, '../skills/README.md'), 'utf8');
	const section = readme.slice(readme.indexOf('## Reference skills'), readme.indexOf('## Workflow skills'));
	return [...section.matchAll(/^\| \[`([a-z0-9-]+)`\]/gm)].map((m) => m[1]);
}

const isDomain = (c: Coverage): c is StyleDomain<any> => 'checks' in c;

describe('house-style coverage', () => {
	it('maps every reference skill, and nothing else', () => {
		const skills = referenceSkills();
		expect(skills.length).toBeGreaterThan(10);
		expect(skills.filter((s) => !(s in COVERAGE)), 'reference skills with no house-style entry: add their StyleDomain, or { pending: "#issue" }').toEqual([]);
		expect(Object.keys(COVERAGE).filter((s) => !skills.includes(s)), 'entries for skills that no longer exist').toEqual([]);
	});

	it.each(Object.entries(COVERAGE).filter(([, c]) => isDomain(c)) as [string, StyleDomain<any>][])('%s has a style domain the brand reaches', (skill, domain) => {
		expect(domain.id).toBe(skill.replace(/^pixerate-/, ''));
		// The brand's shared checks can run here: through a surface, or because the domain has its own of each.
		const ids = styleChecksOf(domain).map((c) => c.id);
		if (!domain.surface) expect(SHARED_STYLE_CHECKS.map((c) => c.id).every((id) => ids.includes(id))).toBe(true);
		expect(domain.profileSchema.type).toBe('object');
	});

	it('records why a domain has none, or the issue that adds it', () => {
		for (const [skill, c] of Object.entries(COVERAGE)) {
			if (isDomain(c)) continue;
			if ('none' in c) expect(c.none.length, skill).toBeGreaterThan(20);
			else expect(c.pending, skill).toMatch(/^#\d+$/);
		}
	});
});
