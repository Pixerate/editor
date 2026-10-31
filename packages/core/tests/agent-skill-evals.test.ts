/**
 * Runs the evals that workflow skills ship in `skills/<name>/evals/*.json`.
 *
 * An eval is a task a model would be given (`prompt`), the document it starts from
 * (`fixture`), the checks that decide whether the job was done (`checks`: a read tool, its
 * arguments and what its result must match) and one known-good answer (`solution`: the tool
 * calls an expert would make). Here, without a model, each eval proves itself: at least one
 * check fails on the fixture, and every check passes after the solution. A model harness runs
 * the same files with the model in place of `solution`. The format is described in
 * `skills/README.md`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry, baseToolName, createSpreadsheetToolProvider } from '../src/agent';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
import { SpreadsheetController } from '../src';

const SKILLS_DIR = join(__dirname, '..', 'skills');

interface ToolCall {
	tool: string;
	args?: Record<string, unknown>;
}
interface Check extends ToolCall {
	/** What the check is for, shown when it fails. */
	why: string;
	expect: unknown;
}
interface SkillEval {
	prompt: string;
	fixture: SpreadsheetFixture | ImageFixture;
	checks: Check[];
	solution: ToolCall[];
}
interface SpreadsheetFixture {
	editor: 'spreadsheet';
	/** Raw inputs from A1, row by row, typed as a person would (`'` forces text). */
	rows: Array<Array<string | number | boolean | null>>;
}
interface ImageFixture {
	editor: 'image';
	width: number;
	height: number;
	/** RGB background. */
	background: [number, number, number];
	/** Shapes painted over it in order, with RGB colours. */
	shapes: Array<{ shape: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; color: [number, number, number] }>;
}

function spreadsheet(f: SpreadsheetFixture): ToolRegistry {
	const columns = Math.max(...f.rows.map((r) => r.length));
	const sheet = new SpreadsheetController({
		document: {
			columns: Array.from({ length: columns }, (_, i) => ({ id: `c${i}`, key: String.fromCharCode(65 + i), title: String.fromCharCode(65 + i), type: 'freeform' as const })),
			rows: f.rows.map((_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
		}
	});
	f.rows.forEach((row, r) => row.forEach((v, c) => v !== null && v !== '' && sheet.setCellValue(`r${r}`, `c${c}`, String(v))));
	const registry = new ToolRegistry();
	registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
	return registry;
}

function image(f: ImageFixture): ToolRegistry {
	const { width: W, height: H } = f;
	const data = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let rgb = f.background;
			for (const s of f.shapes) {
				const inside =
					s.shape === 'rect'
						? x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height
						: ((x + 0.5 - s.x - s.width / 2) / (s.width / 2)) ** 2 + ((y + 0.5 - s.y - s.height / 2) / (s.height / 2)) ** 2 <= 1;
				if (inside) rgb = s.color;
			}
			data.set([...rgb, 255], (y * W + x) * 4);
		}
	}
	const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
	const c = new ImageEditorController({ image: fake });
	c.setSamplePixels({ width: W, height: H, data });
	const registry = new ToolRegistry();
	registry.register(createImageEditorToolProvider(c));
	return registry;
}

const FIXTURES = { spreadsheet, image } as const;

async function call(registry: ToolRegistry, { tool, args = {} }: ToolCall): Promise<unknown> {
	const res = await registry.callTool(tool, await resolveArgs(registry, args));
	if (res.isError) throw new Error(`${tool}: ${(res.content?.[0] as { text?: string })?.text ?? 'tool error'}`);
	return res.structuredContent;
}

/**
 * Check arguments may read a value from the document instead of naming it, since ids are made
 * by whoever did the job: `{ "$read": "list_layers", "path": "layers.-1.id" }` (a negative
 * index counts from the end).
 */
async function resolveArgs(registry: ToolRegistry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (v && typeof v === 'object' && '$read' in v) {
			const { $read, path } = v as { $read: string; path: string };
			out[k] = at(await call(registry, { tool: $read }), path);
		} else out[k] = v;
	}
	return out;
}

function at(value: unknown, path: string): unknown {
	let cur = value as any;
	for (const key of path.split('.')) {
		if (cur == null) return undefined;
		cur = Array.isArray(cur) && /^-\d+$/.test(key) ? cur[cur.length + Number(key)] : cur[key];
	}
	return cur;
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.every(isEmpty));

/**
 * Whether `actual` matches `expected`. Objects match key by key (other keys are ignored),
 * arrays element by element with the same length, other values exactly. Operators:
 * `$min` / `$max` (numbers), `$type`, `$match` (a regular expression, or `[pattern, flags]`), `$in`, `$not`,
 * `$every` / `$some` (array elements), `$length`, `$unique`, `$distinct` (the distinct
 * values), `$sum`, `$column: [index, matcher]` (one column of a 2D array), `$nonEmpty`
 * (the array without empty cells or rows) and `$expr` (a JavaScript expression over `v`).
 */
function matches(actual: unknown, expected: unknown): boolean {
	if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
	const ops = Object.entries(expected as Record<string, unknown>);
	return ops.every(([key, want]) => {
		const list = Array.isArray(actual) ? actual : null;
		switch (key) {
			case '$min':
				return typeof actual === 'number' && actual >= (want as number);
			case '$max':
				return typeof actual === 'number' && actual <= (want as number);
			case '$type':
				return (actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual) === want;
			case '$match': {
				const [pattern, flags] = Array.isArray(want) ? (want as [string, string]) : [want as string, ''];
				return typeof actual === 'string' && new RegExp(pattern, flags).test(actual);
			}
			case '$in':
				return (want as unknown[]).some((w) => matches(actual, w));
			case '$not':
				return !matches(actual, want);
			case '$every':
				return !!list && list.every((a) => matches(a, want));
			case '$some':
				return !!list && list.some((a) => matches(a, want));
			case '$length':
				return !!list && matches(list.length, want);
			case '$unique':
				return !!list && new Set(list.map((a) => JSON.stringify(a))).size === list.length;
			case '$distinct':
				return !!list && matches([...new Set(list.map((a) => JSON.stringify(a)))].map((a) => JSON.parse(a)), want);
			case '$sum':
				return !!list && list.every((a) => typeof a === 'number') && Math.abs(list.reduce((s: number, a) => s + (a as number), 0) - (want as number)) < 1e-6;
			case '$column': {
				const [index, m] = want as [number, unknown];
				return !!list && matches(list.map((row) => (Array.isArray(row) ? row[index] : undefined)), m);
			}
			case '$expr':
				// A JavaScript expression over the value `v`, for relations matchers cannot state
				// (`v.width === v.height`). Keep it short and prefer the operators above.
				return !!new Function('v', `return (${want as string});`)(actual);
			case '$nonEmpty':
				return !!list && matches(list.filter((a) => !isEmpty(a)), want);
			default:
				if (key.startsWith('$')) throw new Error(`Unknown eval operator ${key}.`);
				return actual !== null && typeof actual === 'object' && matches((actual as Record<string, unknown>)[key], want);
		}
	});
}

async function failedChecks(registry: ToolRegistry, checks: Check[]): Promise<string[]> {
	const failed: string[] = [];
	for (const check of checks) {
		// A check that errors (say, a mask that is not there yet) has failed.
		const result = await call(registry, check).catch((e: Error) => e);
		if (result instanceof Error) failed.push(`${check.why} (${result.message})`);
		else if (!matches(result, check.expect)) failed.push(`${check.why} (${check.tool} → ${JSON.stringify(result).slice(0, 400)})`);
	}
	return failed;
}

const evals = readdirSync(SKILLS_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'evals')))
	.flatMap((e) =>
		readdirSync(join(SKILLS_DIR, e.name, 'evals'))
			.filter((f) => f.endsWith('.json'))
			.map((f) => [`${e.name}/evals/${f}`, JSON.parse(readFileSync(join(SKILLS_DIR, e.name, 'evals', f), 'utf8')) as SkillEval] as const)
	);

describe('matches', () => {
	it('matches objects, arrays and operators', () => {
		expect(matches({ a: 1, b: 2 }, { a: 1 })).toBe(true);
		expect(matches([1, 2], [1])).toBe(false);
		expect(matches(5, { $min: 1, $max: 5 })).toBe(true);
		expect(matches([[1, 'a'], [2, 'b'], [null, '']], { $nonEmpty: { $length: 2, $column: [0, { $sum: 3 }] } })).toBe(true);
		expect(matches(['x', 'X'], { $distinct: { $length: 2 } })).toBe(true);
		expect(matches(['a', 'a'], { $unique: true })).toBe(false);
		expect(matches({ width: 4, height: 4 }, { $expr: 'v.width === v.height' })).toBe(true);
		expect(() => matches(1, { $near: 1 })).toThrow(/Unknown eval operator/);
	});
});

describe.each(evals)('%s', (_, ev) => {
	it('is well formed', () => {
		expect(ev.prompt.length).toBeGreaterThan(20);
		expect(Object.keys(FIXTURES)).toContain(ev.fixture.editor);
		expect(ev.checks.length).toBeGreaterThan(0);
		for (const c of ev.checks) expect(c.why, 'every check says what it is for').toBeTruthy();
		const registry = FIXTURES[ev.fixture.editor](ev.fixture as never);
		const tools = new Set(registry.listTools().tools.map((t) => baseToolName(t.name)));
		const read = new Set(registry.listTools().tools.filter((t) => t.annotations?.readOnlyHint).map((t) => baseToolName(t.name)));
		expect(ev.solution.map((s) => s.tool).filter((t) => !tools.has(t)), 'solution tools exist').toEqual([]);
		expect(ev.checks.map((c) => c.tool).filter((t) => !read.has(t)), 'checks use read-only tools').toEqual([]);
	});

	it('fails on the fixture and passes after the solution', async () => {
		const registry = FIXTURES[ev.fixture.editor](ev.fixture as never);
		expect((await failedChecks(registry, ev.checks)).length, 'some check fails before the job is done').toBeGreaterThan(0);
		for (const step of ev.solution) await call(registry, step);
		expect(await failedChecks(registry, ev.checks)).toEqual([]);
	});
});
