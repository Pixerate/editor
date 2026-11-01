/**
 * The evals that workflow skills ship in `skills/<name>/evals/*.json`, for any harness to run.
 *
 * An eval is a task a model would be given (`prompt`), the document it starts from
 * (`fixture`), the checks that decide whether the job was done (`checks`: a read tool, its
 * arguments and what its result must match) and one known-good answer (`solution`: the tool
 * calls an expert would make). The package's own tests prove each eval with its `solution`; an
 * agent harness builds the fixture, gives its model the `prompt` in place of the solution, then
 * runs `failedEvalChecks`. The format is described in `skills/README.md`.
 */
import type { McpToolResult } from './registry.js';

export interface SkillEvalToolCall {
	tool: string;
	args?: Record<string, unknown>;
}

export interface SkillEvalCheck extends SkillEvalToolCall {
	/** What the check is for, shown when it fails. */
	why: string;
	expect: unknown;
}

export interface SkillEval {
	prompt: string;
	fixture: SpreadsheetEvalFixture | ImageEvalFixture | VectorEvalFixture | PaintEvalFixture | VideoEvalFixture | ChartEvalFixture | DiagramEvalFixture | RichTextEvalFixture | AnimationEvalFixture;
	checks: SkillEvalCheck[];
	solution: SkillEvalToolCall[];
}

export interface SpreadsheetEvalFixture {
	editor: 'spreadsheet';
	/** Raw inputs from A1, row by row, typed as a person would (`'` forces text). */
	rows: Array<Array<string | number | boolean | null>>;
}

export interface ImageEvalFixture {
	editor: 'image';
	width: number;
	height: number;
	/** RGB background. */
	background: [number, number, number];
	/** Shapes painted over it in order, with RGB colours. */
	shapes: Array<{ shape: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; color: [number, number, number] }>;
}

export interface VectorEvalFixture {
	editor: 'vector';
	width: number;
	height: number;
	/** Commands that build the starting artwork, run in order (`"$0.id"` refers to an earlier result). */
	setup?: Array<{ id: string; params?: Record<string, unknown> }>;
}

export interface PaintEvalFixture {
	editor: 'paint';
	width: number;
	height: number;
	/** Tool calls that prepare the canvas (paper, layers, strokes), run in order. */
	setup?: SkillEvalToolCall[];
}

export interface VideoEvalFixture {
	editor: 'video';
	/** Tool calls that build the starting project (settings, assets, clips, markers), run in order. */
	setup?: SkillEvalToolCall[];
}

export interface ChartEvalFixture {
	editor: 'chart';
	/** Tool calls that build the starting chart (`set_chart_data`, `update_chart`), run in order. */
	setup?: SkillEvalToolCall[];
}

export interface DiagramEvalFixture {
	editor: 'diagram';
	/** Tool calls that build the starting diagram (`load_diagram_mermaid`), run in order. */
	setup?: SkillEvalToolCall[];
}

export interface RichTextEvalFixture {
	editor: 'rich-text';
	/** The starting document as HTML. */
	html: string;
}

export interface AnimationEvalFixture {
	editor: 'animation';
	/** Tool calls that build the starting scene (`set_animation_artwork_svg`, `insert_shots`), run in order. */
	setup?: SkillEvalToolCall[];
}

/** One eval file of a skill. */
export interface SkillEvalFile {
	skill: string;
	/** Path relative to the skills directory, e.g. `pixerate-image-selection-masking/evals/local-adjustment.json`. */
	path: string;
	eval: SkillEval;
}

/**
 * The evals in a set of skill files (paths relative to the skills directory, contents as text,
 * like `SkillFiles` but including `evals/*.json`), sorted by path.
 */
export function listSkillEvals(files: Readonly<Record<string, string>>): SkillEvalFile[] {
	const out: SkillEvalFile[] = [];
	for (const [raw, text] of Object.entries(files)) {
		const path = raw.replace(/\\/g, '/').replace(/^\.?\//, '');
		const match = /^([^/]+)\/evals\/[^/]+\.json$/.exec(path);
		if (match) out.push({ skill: match[1], path, eval: JSON.parse(text) as SkillEval });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The RGBA pixels of an image fixture: shapes painted over the background in order. */
export function imageEvalFixturePixels(f: ImageEvalFixture): { width: number; height: number; data: Uint8ClampedArray } {
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
	return { width: W, height: H, data };
}

/** Calls a tool by the bare name an eval uses; the harness maps it to its own names if it must. */
export type SkillEvalToolCaller = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;

/** Calls one eval tool step (resolving `$read` arguments); throws with the tool's error text. */
export async function callEvalTool(callTool: SkillEvalToolCaller, { tool, args = {} }: SkillEvalToolCall): Promise<unknown> {
	const res = await callTool(tool, (await resolve(callTool, args)) as Record<string, unknown>);
	if (res.isError) throw new Error(`${tool}: ${(res.content?.[0] as { text?: string })?.text ?? 'tool error'}`);
	return res.structuredContent;
}

/**
 * Arguments may read a value from the document instead of naming it, since ids are made by
 * whoever did the job: `{ "$read": "list_layers", "path": "layers.-1.id" }`, with `args` for
 * the read (`{ "$read": "run_command", "args": { "id": "vector.list" }, "path":
 * "result.nodes.*.id" }`). A negative index counts from the end; `*` maps over an array.
 */
async function resolve(callTool: SkillEvalToolCaller, v: unknown): Promise<unknown> {
	if (Array.isArray(v)) return Promise.all(v.map((x) => resolve(callTool, x)));
	if (!v || typeof v !== 'object') return v;
	if ('$read' in v) {
		const { $read, args, path } = v as { $read: string; args?: Record<string, unknown>; path: string };
		return at(await callEvalTool(callTool, { tool: $read, args }), path);
	}
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) out[k] = await resolve(callTool, x);
	return out;
}

function at(value: unknown, path: string): unknown {
	const [key, ...rest] = path.split('.');
	if (value == null || key === undefined) return value;
	if (key === '*') return Array.isArray(value) ? (rest.length ? value.map((x) => at(x, rest.join('.'))) : value) : undefined;
	const next = Array.isArray(value) && /^-\d+$/.test(key) ? value[value.length + Number(key)] : (value as any)[key];
	return rest.length ? at(next, rest.join('.')) : next;
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
export function matchesEvalExpectation(actual: unknown, expected: unknown): boolean {
	const matches = matchesEvalExpectation;
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
				// An expression that throws (reading into a value that is not there yet) does not match.
				try {
					return !!new Function('v', `return (${want as string});`)(actual);
				} catch {
					return false;
				}
			case '$nonEmpty':
				return !!list && matches(list.filter((a) => !isEmpty(a)), want);
			default:
				if (key.startsWith('$')) throw new Error(`Unknown eval operator ${key}.`);
				return actual !== null && typeof actual === 'object' && matches((actual as Record<string, unknown>)[key], want);
		}
	});
}

/** The checks that fail, each as its `why` with what the tool returned (or its error). */
export async function failedEvalChecks(callTool: SkillEvalToolCaller, checks: readonly SkillEvalCheck[]): Promise<string[]> {
	const failed: string[] = [];
	for (const check of checks) {
		// A check that errors (say, a mask that is not there yet) has failed.
		const result = await callEvalTool(callTool, check).catch((e: Error) => e);
		if (result instanceof Error) failed.push(`${check.why} (${result.message})`);
		else if (!matchesEvalExpectation(result, check.expect)) failed.push(`${check.why} (${check.tool} → ${JSON.stringify(result).slice(0, 400)})`);
	}
	return failed;
}
