/// <reference types="node" />
/**
 * `pixerate-style`: check, scaffold and preview house-style skills from a terminal.
 *
 *   pixerate-style check <dir> [--json] [--tokens <file>]   (a skill that extends another reads it from a sibling folder)
 *   pixerate-style schema <domain> [--out <file>]
 *   pixerate-style init <dir> [--profiles brand,chart] [--description <text>]
 *   pixerate-style preview <dir> [--port <n>] [--tokens <file>]
 *
 * The domains are the ones this package ships (brand, chart, tokens). Hosts with their own
 * domains call `checkStyleSkill` / `renderStylePreview` from `@pixerate/editor/tools` instead.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
	STYLE_SKILL_NAME,
	STYLE_TEXT_FILE,
	brandStyleDomain,
	checkStyleSkill,
	renderStylePreview,
	scaffoldStyleSkill,
	styleProfileSchema,
	type StyleDomain,
	type StyleSkillReport,
	type StyleTokenSource
} from '../tools/index.js';
import { chartStyleDomain } from '../chart/style.js';
import { tokensStyleDomain } from '../tokens/style.js';
import { richTextStyleDomain } from '../richTextStyle.js';
import { spreadsheetStyleDomain } from '../spreadsheet/style.js';
import { diagramStyleDomain } from '../diagram/style.js';
import { canvasStyleDomain } from '../canvas/style.js';
import { typographyStyleDomain } from '../typography/style.js';
import { imageStyleDomain } from '../image-editor/style.js';
import { paintStyleDomain } from '../paint-editor/style.js';
import { animationStyleDomain } from '../animation-editor/style.js';
import { videoStyleDomain } from '../video-editor/style.js';
import { generationStyleDomain } from '../generation/style.js';
import { parametersStyleDomain } from '../parameters/style.js';
import { vectorStyleDomain } from '../vector/style.js';
import { effectAuthoringStyleDomain } from '../effects/authoring-style.js';
import { stickerStyleDomain } from '../stickers/style.js';
import { brushStyleDomain } from '../brushes/style.js';

/** The domains the command knows: every editor domain this package ships, and the brand. */
export const STYLE_CLI_DOMAINS: readonly StyleDomain<any>[] = [
	chartStyleDomain,
	tokensStyleDomain,
	richTextStyleDomain,
	spreadsheetStyleDomain,
	diagramStyleDomain,
	canvasStyleDomain,
	typographyStyleDomain,
	imageStyleDomain,
	paintStyleDomain,
	animationStyleDomain,
	videoStyleDomain,
	generationStyleDomain,
	parametersStyleDomain,
	vectorStyleDomain,
	effectAuthoringStyleDomain,
	stickerStyleDomain,
	brushStyleDomain,
	brandStyleDomain
];


/** A skill folder's text files keyed by relative path, and what was left out. */
export function readStyleSkillFolder(dir: string): { files: Record<string, string>; skipped: string[] } {
	const files: Record<string, string> = {};
	const skipped: string[] = [];
	const walk = (rel: string, depth: number) => {
		for (const entry of readdirSync(path.join(dir, rel)).sort()) {
			const relPath = rel ? `${rel}/${entry}` : entry;
			if (entry.startsWith('.')) {
				skipped.push(`${relPath}: hidden files are left out.`);
				continue;
			}
			const stat = lstatSync(path.join(dir, relPath));
			if (stat.isSymbolicLink()) skipped.push(`${relPath}: links are left out.`);
			else if (stat.isDirectory()) {
				if (depth >= 4) skipped.push(`${relPath}: folders more than four deep are left out.`);
				else walk(relPath, depth + 1);
			} else if (!STYLE_TEXT_FILE.test(entry)) skipped.push(`${relPath}: only text files (md, json, yaml, svg, ...) are offered to agents.`);
			else files[relPath] = readFileSync(path.join(dir, relPath), 'utf8');
		}
	};
	walk('', 0);
	return { files, skipped };
}

/** The skills a draft `extends`, read from folders beside it (`styles/night` extends `styles/paper`). */
export function siblingBases(dir: string): { files(name: string): Promise<string[] | undefined>; readFile(name: string, file: string): Promise<string | undefined> } {
	const folder = (name: string) => {
		const at = path.join(path.dirname(path.resolve(dir)), name);
		return STYLE_SKILL_NAME.test(name) && existsSync(at) && lstatSync(at).isDirectory() ? at : undefined;
	};
	return {
		files: async (name) => {
			const at = folder(name);
			return at ? Object.keys(readStyleSkillFolder(at).files) : undefined;
		},
		readFile: async (name, file) => {
			const at = folder(name);
			return at ? readStyleSkillFolder(at).files[file] : undefined;
		}
	};
}

/**
 * Design tokens from a JSON file for `$token` references: a flat map (`{ "brand/primary": "#0b5fff" }`)
 * or nested groups whose leaves are values or `{ "$value": ... }` (`{ "brand": { "primary": { "$value": "#0b5fff" } } }`).
 */
export function tokenSourceFromJson(json: unknown): StyleTokenSource {
	const values = new Map<string, string | number | boolean>();
	const walk = (node: unknown, prefix: string) => {
		if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
			if (prefix) values.set(prefix, node);
			return;
		}
		if (!node || typeof node !== 'object' || Array.isArray(node)) return;
		const value = (node as Record<string, unknown>).$value;
		if (value !== undefined) return walk(value, prefix);
		for (const [key, child] of Object.entries(node)) if (!key.startsWith('$')) walk(child, prefix ? `${prefix}/${key}` : key);
	};
	walk(json, '');
	return {
		resolve: ({ token }) => {
			const value = values.get(token);
			return value === undefined ? { ok: false, message: `the tokens file has no "${token}".` } : { ok: true, value };
		}
	};
}

export interface StyleCliIo {
	out(text: string): void;
	err(text: string): void;
	cwd?: string;
}

const USAGE = `Usage:
  pixerate-style check <dir> [--json] [--tokens <file>]     Report what a host would offer, leave out and why (exit 1 on errors); a base it extends is read from a sibling folder
  pixerate-style schema <domain> [--out <file>]             Write a profile's JSON Schema (domains: ${STYLE_CLI_DOMAINS.map((d) => d.id).join(', ')})
  pixerate-style init <dir> [--profiles brand,chart] [--description <text>]   Start a skill from example profiles
  pixerate-style preview <dir> [--port <n>] [--tokens <file>]   Serve a live preview on 127.0.0.1
`;

function formatReport(report: StyleSkillReport, skipped: string[]): string {
	const lines = [`${report.ok ? 'ok' : 'not ready'}: ${report.name}${report.manifest?.description ? ` - ${report.manifest.description}` : ''}`];
	lines.push(`domains: ${report.domains.join(', ') || '(none)'}`);
	if (report.inherits) lines.push(`extends: ${report.inherits.join(' → ')}`);
	lines.push('files:');
	for (const f of report.files) lines.push(`  ${f.path} (${f.role}, ${f.bytes} B)`);
	for (const s of skipped) lines.push(`  left out: ${s}`);
	for (const e of report.errors) lines.push(`error: ${e}`);
	for (const w of report.warnings) lines.push(`warning: ${w}`);
	for (const [domain, profile] of Object.entries(report.profiles)) lines.push(`${domain} profile: ${JSON.stringify(profile)}`);
	return `${lines.join('\n')}\n`;
}

/** Runs the command; resolves to the exit code. `preview` resolves once the server is listening and returns it. */
export async function runStyleCli(argv: readonly string[], io: StyleCliIo): Promise<{ code: number; server?: Server; close?: () => void }> {
	const [command, target, ...rest] = argv;
	const flag = (name: string) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const resolvePath = (p: string) => path.resolve(io.cwd ?? process.cwd(), p);
	const tokensFlag = flag('--tokens');
	let tokens: StyleTokenSource | undefined;
	if (tokensFlag) {
		try {
			tokens = tokenSourceFromJson(JSON.parse(readFileSync(resolvePath(tokensFlag), 'utf8')));
		} catch (error) {
			io.err(`Could not read the tokens file ${tokensFlag}: ${(error as Error).message}\n`);
			return { code: 2 };
		}
	}
	const check = async (dir: string) => {
		const { files, skipped } = readStyleSkillFolder(dir);
		const report = await checkStyleSkill(path.basename(dir), files, { domains: STYLE_CLI_DOMAINS, bases: siblingBases(dir), ...(tokens ? { tokens } : {}) });
		report.warnings.push(...skipped.map((s) => `${s}`));
		return { report, skipped };
	};

	if (!command || command === 'help' || command === '--help' || command === '-h') {
		io.out(USAGE);
		return { code: command ? 0 : 2 };
	}
	if (!['schema', 'init', 'check', 'preview'].includes(command)) {
		io.err(`Unknown command "${command}".\n${USAGE}`);
		return { code: 2 };
	}
	if (command === 'schema') {
		const domain = STYLE_CLI_DOMAINS.find((d) => d.id === target);
		if (!domain) {
			io.err(`Unknown domain "${target ?? ''}"; use one of ${STYLE_CLI_DOMAINS.map((d) => d.id).join(', ')}.\n`);
			return { code: 2 };
		}
		const text = `${JSON.stringify(styleProfileSchema(domain), null, 2)}\n`;
		const out = flag('--out');
		if (out) writeFileSync(resolvePath(out), text);
		else io.out(text);
		return { code: 0 };
	}
	if (!target) {
		io.err(USAGE);
		return { code: 2 };
	}
	const dir = resolvePath(target);
	if (command === 'init') {
		if (existsSync(path.join(dir, 'SKILL.md'))) {
			io.err(`${target} already has a SKILL.md; init only starts new skills.\n`);
			return { code: 1 };
		}
		const profiles = (flag('--profiles') ?? 'brand').split(',').map((p) => p.trim()).filter(Boolean);
		let files: Record<string, string>;
		try {
			files = scaffoldStyleSkill({ name: path.basename(dir), profiles, domains: STYLE_CLI_DOMAINS, ...(flag('--description') ? { description: flag('--description') } : {}) });
		} catch (error) {
			io.err(`${(error as Error).message}\n`);
			return { code: 2 };
		}
		mkdirSync(dir, { recursive: true });
		for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
		io.out(`Wrote ${Object.keys(files).join(', ')} in ${target}. Edit them, then run: pixerate-style check ${target}\n`);
		return { code: 0 };
	}
	if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
		io.err(`${target} is not a folder.\n`);
		return { code: 2 };
	}
	if (command === 'check') {
		const { report, skipped } = await check(dir);
		io.out(rest.includes('--json') ? `${JSON.stringify({ ...report, skipped }, null, 2)}\n` : formatReport(report, skipped));
		return { code: report.ok ? 0 : 1 };
	}
	if (command === 'preview') {
		const clients = new Set<import('node:http').ServerResponse>();
		const server = createServer(async (req, res) => {
			const host = (req.headers.host ?? '').replace(/:\d+$/, '');
			if (host !== '127.0.0.1' && host !== 'localhost') {
				res.writeHead(403).end();
				return;
			}
			if (req.url === '/reload.js') {
				res.writeHead(200, { 'content-type': 'text/javascript' }).end("new EventSource('/events').onmessage = () => location.reload();\n");
				return;
			}
			if (req.url === '/events') {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
				res.write(': connected\n\n');
				clients.add(res);
				req.on('close', () => clients.delete(res));
				return;
			}
			if (req.url !== '/' && req.url !== '/index.html') {
				res.writeHead(404).end();
				return;
			}
			const { report } = await check(dir);
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderStylePreview(report, STYLE_CLI_DOMAINS, { reload: true }));
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watcher: FSWatcher | undefined;
		try {
			watcher = watch(dir, { recursive: true }, () => {
				clearTimeout(timer);
				timer = setTimeout(async () => {
					const { report, skipped } = await check(dir);
					io.out(formatReport(report, skipped));
					for (const c of clients) c.write('data: reload\n\n');
				}, 100);
			});
		} catch {
			io.err('Watching is not available here; reload the page by hand.\n');
		}
		const port = Number(flag('--port') ?? 0);
		await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
		const address = server.address();
		const actual = typeof address === 'object' && address ? address.port : port;
		io.out(`Previewing ${target} at http://127.0.0.1:${actual}/ (Ctrl+C to stop)\n`);
		io.out(formatReport((await check(dir)).report, []));
		const close = () => {
			watcher?.close();
			clearTimeout(timer);
			for (const c of clients) c.end();
			server.close();
		};
		return { code: 0, server, close };
	}
	return { code: 2 };
}
