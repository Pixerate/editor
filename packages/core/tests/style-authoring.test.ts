import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
	STYLE_FIXTURE_SKILLS,
	ToolRegistry,
	brandStyleDomain,
	checkStyleSkill,
	createStyleResolver,
	createStyleToolProvider,
	memoryStyleStore,
	renderStylePreview,
	scaffoldStyleSkill,
	styleProfileSchema,
	styleStoreConformance,
	type StyleStore
} from '../src/tools';
import { chartStyleDomain, chartStylePreview } from '../src/chart';
import { tokensStyleDomain } from '../src/tokens';
import { readStyleSkillFolder, runStyleCli, tokenSourceFromJson } from '../src/style-cli/run';

const domains = [chartStyleDomain, tokensStyleDomain];
const skillMd = (name: string, extra = '', body = 'Use the brand.') => `---\nname: ${name}\ndescription: ${name} house style.\n${extra}---\n\n${body}\n`;

describe('checkStyleSkill', () => {
	it('reports a good skill as ready, with each file\'s role and the profiles it gives', async () => {
		const report = await checkStyleSkill(
			'acme',
			{
				'SKILL.md': skillMd('acme'),
				'brand.json': JSON.stringify({ $schema: './brand.schema.json', colors: { primary: '#0b5fff', text: '#111111' }, fonts: { body: 'Inter' } }),
				'chart.json': JSON.stringify({ checks: ['palette-only'] }),
				'references/tone.md': 'Be brief.'
			},
			{ domains }
		);
		expect(report).toMatchObject({ name: 'acme', ok: true, errors: [], warnings: [], manifest: { name: 'acme', description: 'acme house style.' } });
		expect(report.domains).toEqual(['chart', 'tokens', 'brand']);
		expect(report.files.map((f) => [f.path, f.role])).toEqual([
			['SKILL.md', 'skill'],
			['brand.json', 'profile'],
			['chart.json', 'profile'],
			['references/tone.md', 'reference']
		]);
		expect(report.brand).toEqual({ colors: { primary: '#0b5fff', text: '#111111' }, fonts: { body: 'Inter' } });
		expect(report.profiles.chart).toEqual({ palette: ['#0b5fff'], theme: { text: '#111111', fontFamily: 'Inter, system-ui, sans-serif' }, checks: ['palette-only'] });
		expect(report.profiles.tokens).toBeUndefined();
	});

	it('says what is left out and what is probably a mistake', async () => {
		const report = await checkStyleSkill(
			'acme',
			{
				'SKILL.md': '---\nname: acme-brand\ndomains: [chart, video]\n---\n\n',
				'chart.json': JSON.stringify({ palette: [], checks: [{ id: 'allowed-type' }] }),
				'diagram.json': '{}'
			},
			{ domains }
		);
		expect(report.ok).toBe(false);
		expect(report.errors).toEqual([
			'It names an unknown domain "video"; the domains here are chart, tokens, brand.',
			expect.stringMatching(/^chart\.json is left out: \/palette: Must have at least 1 items\. checks\[0\] \(allowed-type\)\/types: Missing required property "types"/)
		]);
		expect(report.warnings).toEqual([
			'diagram.json is not a profile for any domain here (chart, tokens, brand); agents can still read it with get_style_file.',
			'SKILL.md is named "acme-brand" but its folder is "acme"; the folder name is what hosts and agents use.',
			'SKILL.md has no description; say what the style is for and when it applies, in one or two sentences.',
			'SKILL.md has no body; write the preferences an agent should follow, and name the files it should read.',
			'The skill has neither preferences nor a profile, so it changes nothing.'
		]);
	});

	it('refuses a folder without SKILL.md, a bad name and missing frontmatter', async () => {
		expect((await checkStyleSkill('acme', { 'brand.json': '{}' }, { domains })).errors).toEqual(['There is no SKILL.md; a store does not offer a folder without one.']);
		expect((await checkStyleSkill('Acme Brand', { 'SKILL.md': skillMd('x') }, { domains })).errors[0]).toMatch(/is not a valid skill name/);
		expect((await checkStyleSkill('acme', { 'SKILL.md': 'Just prose.' }, { domains })).errors[0]).toMatch(/SKILL\.md has no frontmatter/);
	});

	it('resolves $token references with the host\'s tokens, or says there are none', async () => {
		const files = { 'SKILL.md': skillMd('acme'), 'chart.json': JSON.stringify({ palette: [{ $token: 'brand/primary' }] }) };
		expect((await checkStyleSkill('acme', files, { domains })).errors[0]).toMatch(/no design tokens to resolve it/);
		const tokens = tokenSourceFromJson({ brand: { primary: { $value: '#0b5fff' } } });
		expect((await checkStyleSkill('acme', files, { domains, tokens })).profiles.chart).toEqual({ palette: ['#0b5fff'] });
	});
});

describe('schemas, examples and scaffolding', () => {
	it('writes a standalone schema per domain, with its checks and $schema allowed', () => {
		const schema = styleProfileSchema(chartStyleDomain) as any;
		expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
		expect(schema.title).toBe('Charts house-style profile (chart.json)');
		expect(Object.keys(schema.properties)).toEqual(['$schema', 'palette', 'colorSchemes', 'layouts', 'theme', 'defaults', 'checks']);
		expect(schema.properties.checks.items.anyOf[0].enum).toEqual(['palette-only', 'distinguishable', 'min-contrast', 'allowed-type', 'fonts-allowed']);
		expect(schema.properties.checks.items.anyOf.find((s: any) => s.properties?.id?.const === 'allowed-type').properties.types).toBeDefined();
		expect((styleProfileSchema(brandStyleDomain) as any).properties.checks.items.anyOf[0].enum).toEqual(['palette-only', 'min-contrast', 'distinguishable', 'fonts-allowed']);
	});

	it.each([brandStyleDomain, chartStyleDomain, tokensStyleDomain])('the $id example is a valid profile', async (domain) => {
		expect(domain.example).toBeDefined();
		const files = scaffoldStyleSkill({ name: 'start', profiles: [domain.id], domains });
		const report = await checkStyleSkill('start', files, { domains });
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('scaffolds SKILL.md with an optional domains list, and refuses what it cannot write', () => {
		const files = scaffoldStyleSkill({ name: 'acme', profiles: ['brand', 'chart'], domains, limitDomains: true });
		expect(Object.keys(files)).toEqual(['brand.json', 'chart.json', 'SKILL.md']);
		expect(files['SKILL.md']).toMatch(/^---\nname: acme\ndescription: acme house style\. Use when making or changing chart\.\ndomains: \[chart\]\n---/);
		expect(() => scaffoldStyleSkill({ name: 'acme', profiles: ['video'], domains })).toThrow(/There is no domain "video"/);
		expect(() => scaffoldStyleSkill({ name: 'Acme', profiles: [], domains })).toThrow(/not a valid skill name/);
	});
});

describe('previews', () => {
	it('draws a sample chart in the profile', () => {
		const svg = chartStylePreview({ palette: ['#123456', '#abcdef'], theme: { text: '#ff0000' } });
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('#123456');
		expect(svg).toContain('#abcdef');
	});

	it('renders the report as a page that loads nothing and escapes the skill\'s text', async () => {
		const report = await checkStyleSkill(
			'acme',
			{
				'SKILL.md': skillMd('acme').replace('acme house style.', '<script>alert(1)</script>'),
				'brand.json': JSON.stringify({ name: 'Acme', colors: { primary: '#0b5fff' }, fonts: { body: 'Inter' }, logo: { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>' } })
			},
			{ domains }
		);
		const html = renderStylePreview(report, [...domains, brandStyleDomain]);
		expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`);
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('<img class="logo" alt="Logo" src="data:image/svg+xml;charset=utf-8,%3Csvg');
		expect(html).toContain('<figcaption>primary<br><code>#0b5fff</code></figcaption>');
		expect(html).toMatch(/<h2>Charts <small>chart\.json<\/small><\/h2><div class="sample"><svg/);
		expect(renderStylePreview(report, domains, { reload: true })).toContain(`script-src 'self'`);
	});
});

describe('styleStoreConformance', () => {
	const seeded = ({ files, state }: { files: Record<string, string>; state: Record<string, any> }) => memoryStyleStore(files, state);

	it('passes for the memory store', async () => {
		const cases = styleStoreConformance(seeded);
		expect(cases.length).toBeGreaterThanOrEqual(5);
		for (const c of cases) await c.run();
	});

	it('fails a store that loses nested files or state, saying what it expected', async () => {
		const lossy = (seed: { files: Record<string, string>; state: Record<string, any> }): StyleStore => {
			const inner = memoryStyleStore(Object.fromEntries(Object.entries(seed.files).filter(([p]) => !p.includes('/references/'))));
			return { list: inner.list, read: inner.read, files: inner.files };
		};
		const results = await Promise.all(styleStoreConformance(lossy).map((c) => c.run().then(() => 'pass', (e: Error) => e.message)));
		expect(results.filter((r) => r !== 'pass').length).toBeGreaterThanOrEqual(3);
		expect(results.join('\n')).toMatch(/Style store conformance: list\(\) names: expected/);
	});

	it('ships fixtures with a working brand and a broken skill', async () => {
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(STYLE_FIXTURE_SKILLS) }], domains });
		expect((await styles.resolve('chart')).profile.palette).toEqual(['#0b5fff', '#ff6a00']);
		expect((await styles.list()).find((s) => s.name === 'fixture-broken')?.issues[0]).toMatch(/brand\.json is not valid JSON/);
	});
});

describe('agent path', () => {
	const registry = () => {
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({}) }], domains, tokens: tokenSourceFromJson({ 'brand/primary': '#0b5fff' }) });
		const r = new ToolRegistry();
		r.register(createStyleToolProvider(styles));
		return r;
	};

	it('check_style_skill checks a draft with the host\'s domains and tokens, saving nothing', async () => {
		const r = registry();
		const ok = await r.callTool('check_style_skill', { name: 'acme', files: { 'SKILL.md': skillMd('acme'), 'chart.json': JSON.stringify({ palette: [{ $token: 'brand/primary' }] }) } });
		expect(ok.isError).toBeFalsy();
		expect(ok.structuredContent).toMatchObject({ ok: true, profiles: { chart: { palette: ['#0b5fff'] } } });
		const bad = await r.callTool('check_style_skill', { name: 'acme', files: { 'SKILL.md': skillMd('acme'), 'chart.json': '{ nope' } });
		expect(bad.structuredContent).toMatchObject({ ok: false, errors: [expect.stringMatching(/^chart\.json is not valid JSON/)] });
		expect((await r.callTool('list_styles', {})).structuredContent).toMatchObject({ skills: [] });
	});

	it('check_style_skill refuses bad arguments', async () => {
		const r = registry();
		expect((await r.callTool('check_style_skill', { name: 'acme' })).isError).toBe(true);
		expect((await r.callTool('check_style_skill', { name: 'acme', files: { 'SKILL.md': 3 } })).isError).toBe(true);
		const huge = await r.callTool('check_style_skill', { name: 'acme', files: { 'SKILL.md': 'x'.repeat(4 * 1024 * 1024 + 1) } });
		expect(huge.isError).toBe(true);
		expect((huge.content[0] as any).text).toMatch(/at most 4 MB/);
	});

	it('get_style_schema includes shared checks and the example', async () => {
		const schema = await registry().callTool('get_style_schema', { domain: 'tokens' });
		const out = schema.structuredContent as any;
		expect(out.checks.map((c: any) => c.id)).toEqual(['required-variables', 'name-pattern', 'required-modes', 'contrast-pairs', 'palette-only', 'min-contrast', 'distinguishable', 'fonts-allowed']);
		expect(out.example).toEqual(tokensStyleDomain.example);
	});
});

describe('pixerate-style', () => {
	let dir: string;
	let close: (() => void) | undefined;
	afterEach(() => {
		close?.();
		close = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), cwd: dir } };
	};

	it('init writes a skill that check passes; check fails on errors and prints JSON', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		const a = io();
		expect((await runStyleCli(['init', 'acme', '--profiles', 'brand,chart'], a.io)).code).toBe(0);
		expect(a.out.join('')).toMatch(/Wrote brand\.json, chart\.json, SKILL\.md in acme/);
		expect((await runStyleCli(['init', 'acme'], a.io)).code).toBe(1);
		const b = io();
		expect((await runStyleCli(['check', 'acme'], b.io)).code).toBe(0);
		expect(b.out.join('')).toMatch(/^ok: acme/);

		writeFileSync(path.join(dir, 'acme', 'chart.json'), '{ "palette": [] }');
		writeFileSync(path.join(dir, 'acme', 'logo.png'), 'x');
		mkdirSync(path.join(dir, 'acme', '.git'));
		symlinkSync(path.join(dir, 'acme', 'SKILL.md'), path.join(dir, 'acme', 'link.md'));
		const c = io();
		expect((await runStyleCli(['check', 'acme', '--json'], c.io)).code).toBe(1);
		const json = JSON.parse(c.out.join(''));
		expect(json.ok).toBe(false);
		expect(json.errors[0]).toMatch(/^chart\.json is left out/);
		expect(json.skipped).toEqual(['.git: hidden files are left out.', 'link.md: links are left out.', 'logo.png: only text files (md, json, yaml, svg, ...) are offered to agents.']);
	});

	it('schema writes a domain schema; unknown domains, folders and commands fail', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		const a = io();
		expect((await runStyleCli(['schema', 'brand', '--out', 'brand.schema.json'], a.io)).code).toBe(0);
		expect(JSON.parse(readFileSync(path.join(dir, 'brand.schema.json'), 'utf8')).title).toBe('Brand house-style profile (brand.json)');
		expect((await runStyleCli(['schema', 'video'], a.io)).code).toBe(2);
		expect((await runStyleCli(['check', 'missing'], a.io)).code).toBe(2);
		expect((await runStyleCli(['frobnicate', 'x'], a.io)).code).toBe(2);
		expect((await runStyleCli([], a.io)).code).toBe(2);
		expect(a.err.join('')).toMatch(/Unknown domain "video"[\s\S]*missing is not a folder[\s\S]*Unknown command "frobnicate"/);
	});

	it('knows every editor domain the package ships', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		const a = io();
		for (const domain of ['rich-text', 'spreadsheet', 'diagram', 'canvas', 'typography', 'image-editor', 'paint-editor', 'animation-editor', 'video-editor', 'generation', 'parameters', 'vector', 'effect-authoring', 'stickers', 'brushes']) {
			expect((await runStyleCli(['schema', domain], a.io)).code, domain).toBe(0);
		}
		expect((await runStyleCli(['init', 'acme', '--profiles', 'brand,vector,brushes'], a.io)).code).toBe(0);
		expect((await runStyleCli(['check', 'acme'], a.io)).code).toBe(0);
	});

	it('check resolves $token references from a tokens file', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		mkdirSync(path.join(dir, 'acme'));
		writeFileSync(path.join(dir, 'acme', 'SKILL.md'), skillMd('acme'));
		writeFileSync(path.join(dir, 'acme', 'chart.json'), JSON.stringify({ palette: [{ $token: 'brand/primary' }] }));
		writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ 'brand/primary': '#0b5fff' }));
		const a = io();
		expect((await runStyleCli(['check', 'acme'], a.io)).code).toBe(1);
		const b = io();
		expect((await runStyleCli(['check', 'acme', '--tokens', 'tokens.json'], b.io)).code).toBe(0);
		expect(b.out.join('')).toContain('chart profile: {"palette":["#0b5fff"]}');
		expect((await runStyleCli(['check', 'acme', '--tokens', 'nope.json'], b.io)).code).toBe(2);
	});

	it('preview serves the page on 127.0.0.1 only, with live reload', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		const a = io();
		await runStyleCli(['init', 'acme', '--profiles', 'brand,chart'], a.io);
		const result = await runStyleCli(['preview', 'acme'], a.io);
		close = result.close;
		const port = (result.server!.address() as { port: number }).port;
		const get = (url: string, host = `127.0.0.1:${port}`) =>
			new Promise<{ status: number; body: string }>((resolve, reject) => {
				const req = request({ host: '127.0.0.1', port, path: url, headers: { host } }, (res) => {
					let body = '';
					res.on('data', (d) => (body += d));
					res.on('end', () => resolve({ status: res.statusCode!, body }));
				});
				req.on('error', reject);
				req.end();
			});
		const page = await get('/');
		expect(page.status).toBe(200);
		expect(page.body).toContain('<script src="/reload.js"></script>');
		expect(page.body).toContain('<div class="sample"><svg');
		expect((await get('/reload.js')).body).toContain("new EventSource('/events')");
		expect((await get('/', 'evil.example:80')).status).toBe(403);
		expect((await get('/SKILL.md')).status).toBe(404);
		expect(a.out.join('')).toMatch(/Previewing acme at http:\/\/127\.0\.0\.1:\d+\//);
	});

	it('reads only text files from a folder', () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'pixerate-style-'));
		mkdirSync(path.join(dir, 'a/b/c/d/e'), { recursive: true });
		writeFileSync(path.join(dir, 'SKILL.md'), 'x');
		writeFileSync(path.join(dir, 'a/b/c/d/e/deep.md'), 'x');
		const { files, skipped } = readStyleSkillFolder(dir);
		expect(Object.keys(files)).toEqual(['SKILL.md']);
		expect(skipped).toEqual(['a/b/c/d/e: folders more than four deep are left out.']);
	});
});
