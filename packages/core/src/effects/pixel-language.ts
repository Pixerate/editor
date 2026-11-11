/**
 * Pixel expressions: the small, bounded language that effects written at run time (by a person or
 * an agent) use. It is data, not code: there are no loops, no functions of your own, no memory and
 * no access to anything but the pixel's position, the time and the effect's controls. Every
 * program runs a fixed number of steps per pixel (its `cost`, capped by `maxCost`), so it cannot
 * hang the GPU or the host app, and hosts that may not run downloaded code (App Store 2.5.2) can
 * still let agents write effects. The same source compiles to a CPU evaluator here and in Swift,
 * and to Metal Shading Language in Swift (`PixelMSL`).
 *
 * ```
 * // Rings that spread from the middle.
 * control speed: number = 1 range 0 4    // Turns a second.
 * control ink: color = #1d2b53           // Colour of the rings.
 * let d = distance(uv, vec2(0.5, 0.5))
 * let v = 0.5 + 0.5 * sin(d * 40 - time * speed * TAU)
 * out = vec4(ink, v)
 * ```
 *
 * The full reference is in `docs/pixel-expressions.md`. This file is the executable
 * specification: `packages/swift/Sources/PixeratePaint/Effects/PixelLanguage.swift` ports it.
 */

import type { EffectAuthoringIssue } from './authoring.js';
import type { EffectValue, EffectValues } from './types.js';

/** The `sourceLanguage` of pixel expression effects. */
export const PIXEL_LANGUAGE = 'pixel' as const;

/** Limits a program must stay within. */
export interface PixelLimits {
	/** Longest source in UTF-16 code units (default 65536). */
	maxSourceLength?: number;
	/** Most work per pixel, in expression steps (`noise` counts 4; default 1024). */
	maxCost?: number;
}

export const PIXEL_DEFAULT_LIMITS: Required<PixelLimits> = { maxSourceLength: 65536, maxCost: 1024 };

export type PixelControlType = 'number' | 'color' | 'bool' | 'vec2';

/** A `control` line: one of the effect's settings. */
export interface PixelControl {
	name: string;
	type: PixelControlType;
	/** `#rrggbb` for colours, `[x, y]` for vec2. */
	default: EffectValue;
	min?: number;
	max?: number;
	/** The comment at the end of its line. */
	description: string;
	line: number;
}

export type PixelExpr =
	| { k: 'num'; v: number; size: 1; line: number }
	| { k: 'const'; v: readonly number[]; size: number; line: number }
	| { k: 'var'; name: string; size: number; line: number }
	| { k: 'neg'; a: PixelExpr; size: number; line: number }
	| { k: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!='; a: PixelExpr; b: PixelExpr; size: number; line: number }
	| { k: 'call'; fn: string; args: PixelExpr[]; size: number; line: number }
	| { k: 'swizzle'; a: PixelExpr; comps: readonly number[]; size: number; line: number };

/** A compiled program: its controls, its `let`s in order, and what it puts out. */
export interface PixelProgram {
	controls: readonly PixelControl[];
	lets: readonly { name: string; expr: PixelExpr; line: number }[];
	out: PixelExpr;
	/** Steps per pixel. */
	cost: number;
}

export type PixelCompileResult =
	| { ok: true; program: PixelProgram; issues: EffectAuthoringIssue[] }
	| { ok: false; issues: EffectAuthoringIssue[] };

/** Values every program can read, with their sizes. */
export const PIXEL_BUILTINS: Readonly<Record<string, { size: number; description: string }>> = {
	uv: { size: 2, description: 'Where the pixel is, 0..1 across and down from the top left (pixel centres).' },
	pos: { size: 2, description: 'Where the pixel is, in pixels from the top left (pixel centres: 0.5, 1.5, …).' },
	size: { size: 2, description: 'The size of the picture in pixels.' },
	time: { size: 1, description: 'The effect time in seconds.' },
	PI: { size: 1, description: '3.14159…' },
	TAU: { size: 1, description: '2π.' }
};

type Arity = { min: number; max: number };
/** Functions: how many arguments, and how the result's size is found (`each`: the widest argument, the rest broadcast). */
export const PIXEL_FUNCTIONS: Readonly<Record<string, Arity & { result: 'each' | 'scalar' | 'vec2' | 'vec3' | 'vec4'; description: string }>> = {
	sin: { min: 1, max: 1, result: 'each', description: 'Sine (radians).' },
	cos: { min: 1, max: 1, result: 'each', description: 'Cosine (radians).' },
	tan: { min: 1, max: 1, result: 'each', description: 'Tangent (radians).' },
	asin: { min: 1, max: 1, result: 'each', description: 'Arcsine.' },
	acos: { min: 1, max: 1, result: 'each', description: 'Arccosine.' },
	atan: { min: 1, max: 2, result: 'each', description: 'atan(x), or atan(y, x) for the angle of a point.' },
	sqrt: { min: 1, max: 1, result: 'each', description: 'Square root (0 for negatives).' },
	exp: { min: 1, max: 1, result: 'each', description: 'e to the power.' },
	log: { min: 1, max: 1, result: 'each', description: 'Natural logarithm.' },
	abs: { min: 1, max: 1, result: 'each', description: 'Absolute value.' },
	sign: { min: 1, max: 1, result: 'each', description: '-1, 0 or 1.' },
	floor: { min: 1, max: 1, result: 'each', description: 'Rounds down.' },
	ceil: { min: 1, max: 1, result: 'each', description: 'Rounds up.' },
	fract: { min: 1, max: 1, result: 'each', description: 'x - floor(x).' },
	pow: { min: 2, max: 2, result: 'each', description: 'pow(x, y).' },
	mod: { min: 2, max: 2, result: 'each', description: 'mod(x, y) = x - y·floor(x / y) (the same as x % y).' },
	min: { min: 2, max: 2, result: 'each', description: 'The smaller.' },
	max: { min: 2, max: 2, result: 'each', description: 'The larger.' },
	clamp: { min: 3, max: 3, result: 'each', description: 'clamp(x, lo, hi).' },
	mix: { min: 3, max: 3, result: 'each', description: 'mix(a, b, t) = a + (b - a)·t.' },
	step: { min: 2, max: 2, result: 'each', description: 'step(edge, x): 0 below edge, else 1.' },
	smoothstep: { min: 3, max: 3, result: 'each', description: 'smoothstep(lo, hi, x): a smooth 0..1 ramp.' },
	select: { min: 3, max: 3, result: 'each', description: 'select(c, a, b): a where c > 0.5, else b (c is a number).' },
	length: { min: 1, max: 1, result: 'scalar', description: 'Length of a vector.' },
	distance: { min: 2, max: 2, result: 'scalar', description: 'Distance between two points.' },
	dot: { min: 2, max: 2, result: 'scalar', description: 'Dot product.' },
	normalize: { min: 1, max: 1, result: 'each', description: 'The vector at length 1 (0 stays 0).' },
	hash: { min: 1, max: 1, result: 'scalar', description: 'hash(p): a random 0..1 for each whole-number cell of a vec2.' },
	noise: { min: 1, max: 1, result: 'scalar', description: 'noise(p): smooth value noise 0..1 over a vec2.' },
	vec2: { min: 1, max: 2, result: 'vec2', description: 'A vec2 from parts (or one number for both).' },
	vec3: { min: 1, max: 3, result: 'vec3', description: 'A vec3 from parts (or one number for all).' },
	vec4: { min: 1, max: 4, result: 'vec4', description: 'A vec4 from parts (or one number for all).' }
};

const KEYWORDS = new Set(['control', 'let', 'out', 'range', 'true', 'false']);
const TYPE_NAMES: readonly PixelControlType[] = ['number', 'color', 'bool', 'vec2'];
const sizeName = (n: number) => (n === 1 ? 'number' : `vec${n}`);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Tok =
	| { t: 'num'; v: number; line: number }
	| { t: 'color'; v: number[]; line: number }
	| { t: 'id'; v: string; line: number }
	| { t: 'op'; v: string; line: number }
	| { t: 'nl'; line: number };

class PixelSyntaxError extends Error {
	constructor(
		message: string,
		readonly line: number
	) {
		super(message);
	}
}

function tokenize(source: string, comments: Map<number, string>): Tok[] {
	const out: Tok[] = [];
	let line = 1;
	let depth = 0;
	let i = 0;
	const n = source.length;
	while (i < n) {
		const c = source[i];
		if (c === '\n') {
			if (depth === 0) out.push({ t: 'nl', line });
			line++;
			i++;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			i++;
			continue;
		}
		if (c === ';') {
			if (depth === 0) out.push({ t: 'nl', line });
			i++;
			continue;
		}
		if (c === '/' && source[i + 1] === '/') {
			let j = i + 2;
			while (j < n && source[j] !== '\n') j++;
			const text = source.slice(i + 2, j).trim();
			if (!comments.has(line)) comments.set(line, text);
			i = j;
			continue;
		}
		if ((c >= '0' && c <= '9') || (c === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
			const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i, i + 64));
			const text = m![0];
			out.push({ t: 'num', v: Number(text), line });
			i += text.length;
			continue;
		}
		if (c === '#') {
			const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/.exec(source.slice(i, i + 10));
			if (!m) throw new PixelSyntaxError('a colour is written #rrggbb or #rrggbbaa, e.g. #ff8800', line);
			const hex = m[1];
			const v: number[] = [];
			for (let k = 0; k < hex.length; k += 2) v.push(parseInt(hex.slice(k, k + 2), 16) / 255);
			out.push({ t: 'color', v, line });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
			out.push({ t: 'id', v: source.slice(i, j), line });
			i = j;
			continue;
		}
		const two = source.slice(i, i + 2);
		if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '..') {
			out.push({ t: 'op', v: two, line });
			i += 2;
			continue;
		}
		if ('+-*/%()<>,.:='.includes(c)) {
			if (c === '(') depth++;
			if (c === ')') depth = Math.max(0, depth - 1);
			out.push({ t: 'op', v: c, line });
			i++;
			continue;
		}
		throw new PixelSyntaxError(`unexpected character "${c}"`, line);
	}
	out.push({ t: 'nl', line });
	return out;
}

// ---------------------------------------------------------------------------
// Parser and checker
// ---------------------------------------------------------------------------

const describeTok = (t: Tok | undefined): string =>
	!t || t.t === 'nl' ? 'the end of the line' : t.t === 'num' ? `the number ${t.v}` : t.t === 'color' ? 'a colour' : `"${t.v}"`;

/**
 * Parses and type-checks a pixel expression program. Problems come back as issues with 1-based
 * line numbers (errors stop it compiling; warnings, such as an unused control, do not).
 */
export function compilePixelSource(source: string, limits: PixelLimits = {}): PixelCompileResult {
	const lim = { ...PIXEL_DEFAULT_LIMITS, ...limits };
	const issues: EffectAuthoringIssue[] = [];
	if (source.length > lim.maxSourceLength) {
		return { ok: false, issues: [{ severity: 'error', message: `the source is ${source.length} characters; the limit is ${lim.maxSourceLength}` }] };
	}
	const comments = new Map<number, string>();
	let toks: Tok[];
	try {
		toks = tokenize(source, comments);
	} catch (e) {
		const err = e as PixelSyntaxError;
		return { ok: false, issues: [{ severity: 'error', line: err.line, message: err.message }] };
	}

	const controls: PixelControl[] = [];
	const lets: { name: string; expr: PixelExpr; line: number }[] = [];
	const scope = new Map<string, { size: number; kind: 'control' | 'let'; line: number }>();
	const used = new Set<string>();
	let out: { expr: PixelExpr; line: number } | null = null;
	let p = 0;
	/** Names whose line failed: using them later reports nothing more (the first error says it). */
	const poisoned = new Set<string>();
	let declaring: string | null = null;

	const peek = () => toks[p];
	const next = () => toks[p++];
	const isOp = (v: string) => {
		const t = toks[p];
		return t.t === 'op' && t.v === v;
	};
	const expectOp = (v: string, what: string) => {
		const t = next();
		if (t.t !== 'op' || t.v !== v) throw new PixelSyntaxError(`expected "${v}" ${what}, found ${describeTok(t)}`, t.line);
	};
	const ident = (what: string): string => {
		const t = next();
		if (t.t !== 'id') throw new PixelSyntaxError(`expected ${what}, found ${describeTok(t)}`, t.line);
		return t.v;
	};

	const checkNewName = (name: string, line: number) => {
		if (KEYWORDS.has(name)) throw new PixelSyntaxError(`"${name}" is a keyword; pick another name`, line);
		if (name in PIXEL_BUILTINS) throw new PixelSyntaxError(`"${name}" is a built-in value; pick another name`, line);
		if (name in PIXEL_FUNCTIONS) throw new PixelSyntaxError(`"${name}" is a function; pick another name`, line);
		const had = scope.get(name);
		if (had) throw new PixelSyntaxError(`"${name}" is already defined on line ${had.line}; names can't be reused`, line);
	};

	const signedNumber = (what: string): number => {
		let sign = 1;
		if (isOp('-')) {
			next();
			sign = -1;
		}
		const t = next();
		if (t.t !== 'num') throw new PixelSyntaxError(`expected ${what}, found ${describeTok(t)}`, t.line);
		return sign * t.v;
	};

	// Expressions -------------------------------------------------------------
	const combine = (a: PixelExpr, b: PixelExpr, op: string, line: number): number => {
		if (a.size === b.size || b.size === 1) return a.size;
		if (a.size === 1) return b.size;
		throw new PixelSyntaxError(`can't use "${op}" on a ${sizeName(a.size)} and a ${sizeName(b.size)}; make them the same size (e.g. with .xy or vec3(…))`, line);
	};

	const parseExpr = (): PixelExpr => {
		const a = parseAdd();
		const t = peek();
		if (t.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.v)) {
			next();
			const b = parseAdd();
			if (a.size !== 1 || b.size !== 1) throw new PixelSyntaxError(`"${t.v}" compares two numbers; this is a ${sizeName(a.size)} and a ${sizeName(b.size)} (compare one part, e.g. uv.x)`, t.line);
			const after = peek();
			if (after.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(after.v)) throw new PixelSyntaxError('comparisons can\'t be chained; combine them with min/max or select', after.line);
			return { k: 'bin', op: t.v as '<', a, b, size: 1, line: t.line };
		}
		return a;
	};
	const parseAdd = (): PixelExpr => {
		let a = parseMul();
		for (;;) {
			const t = peek();
			if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
				next();
				const b = parseMul();
				a = { k: 'bin', op: t.v, a, b, size: combine(a, b, t.v, t.line), line: t.line };
			} else return a;
		}
	};
	const parseMul = (): PixelExpr => {
		let a = parseUnary();
		for (;;) {
			const t = peek();
			if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
				next();
				const b = parseUnary();
				a = { k: 'bin', op: t.v, a, b, size: combine(a, b, t.v, t.line), line: t.line };
			} else return a;
		}
	};
	const parseUnary = (): PixelExpr => {
		const t = peek();
		if (t.t === 'op' && t.v === '-') {
			next();
			const a = parseUnary();
			return { k: 'neg', a, size: a.size, line: t.line };
		}
		return parsePostfix();
	};
	const parsePostfix = (): PixelExpr => {
		let a = parsePrimary();
		while (isOp('.')) {
			const dot = next();
			const t = next();
			if (t.t !== 'id') throw new PixelSyntaxError(`expected parts such as .x, .xy or .rgb after ".", found ${describeTok(t)}`, dot.line);
			const set = /^[xyzw]+$/.test(t.v) ? 'xyzw' : /^[rgba]+$/.test(t.v) ? 'rgba' : null;
			if (!set || t.v.length > 4) throw new PixelSyntaxError(`".${t.v}" isn't a part of a vector; use up to four of x y z w (or r g b a)`, t.line);
			const comps = [...t.v].map((ch) => set.indexOf(ch));
			const bad = comps.find((c) => c >= a.size);
			if (bad !== undefined) throw new PixelSyntaxError(`a ${sizeName(a.size)} has no ".${set[bad]}"${a.size === 1 ? '' : `; it has ${[...set.slice(0, a.size)].map((s) => '.' + s).join(' ')}`}`, t.line);
			a = { k: 'swizzle', a, comps, size: comps.length, line: t.line };
		}
		return a;
	};
	const parsePrimary = (): PixelExpr => {
		const t = next();
		if (t.t === 'num') return { k: 'num', v: t.v, size: 1, line: t.line };
		if (t.t === 'color') return { k: 'const', v: t.v, size: t.v.length, line: t.line };
		if (t.t === 'op' && t.v === '(') {
			const e = parseExpr();
			expectOp(')', 'to close "("');
			return e;
		}
		if (t.t === 'id') {
			if (isOp('(')) {
				next();
				const args: PixelExpr[] = [];
				if (!isOp(')')) {
					for (;;) {
						args.push(parseExpr());
						if (isOp(',')) {
							next();
							continue;
						}
						break;
					}
				}
				expectOp(')', `to close the call to ${t.v}`);
				return typeCall(t.v, args, t.line);
			}
			if (t.v in PIXEL_BUILTINS) return { k: 'var', name: t.v, size: PIXEL_BUILTINS[t.v].size, line: t.line };
			if (poisoned.has(t.v)) throw new PixelSyntaxError('', t.line);
			const s = scope.get(t.v);
			if (s) {
				used.add(t.v);
				return { k: 'var', name: t.v, size: s.size, line: t.line };
			}
			if (t.v in PIXEL_FUNCTIONS) throw new PixelSyntaxError(`${t.v} is a function; call it, e.g. ${t.v}(…)`, t.line);
			const known = [...scope.keys()];
			throw new PixelSyntaxError(`there is no "${t.v}"; ${known.length ? `defined so far: ${known.join(', ')}; ` : ''}built in: ${Object.keys(PIXEL_BUILTINS).join(', ')}`, t.line);
		}
		throw new PixelSyntaxError(`expected a value, found ${describeTok(t)}`, t.line);
	};

	const typeCall = (fn: string, args: PixelExpr[], line: number): PixelExpr => {
		const spec = PIXEL_FUNCTIONS[fn];
		if (!spec) throw new PixelSyntaxError(`there is no function "${fn}"; the functions are ${Object.keys(PIXEL_FUNCTIONS).join(', ')}`, line);
		if (args.length < spec.min || args.length > spec.max) {
			const want = spec.min === spec.max ? `${spec.min}` : `${spec.min} to ${spec.max}`;
			throw new PixelSyntaxError(`${fn} takes ${want} argument${spec.max === 1 ? '' : 's'}, not ${args.length}`, line);
		}
		if (spec.result === 'vec2' || spec.result === 'vec3' || spec.result === 'vec4') {
			const n = Number(spec.result[3]);
			const total = args.reduce((s, a) => s + a.size, 0);
			if (!(args.length === 1 && args[0].size === 1) && total !== n) throw new PixelSyntaxError(`${fn} needs ${n} parts in all (or one number for all), and these make ${total}`, line);
			return { k: 'call', fn, args, size: n, line };
		}
		if (fn === 'hash' || fn === 'noise') {
			if (args[0].size !== 2) throw new PixelSyntaxError(`${fn} takes a vec2 (e.g. ${fn}(uv * 8)), not a ${sizeName(args[0].size)}`, line);
			return { k: 'call', fn, args, size: 1, line };
		}
		if (fn === 'select' && args[0].size !== 1) throw new PixelSyntaxError(`select's first argument is a number (the condition), not a ${sizeName(args[0].size)}`, line);
		const sized = fn === 'select' ? args.slice(1) : args;
		const n = Math.max(...sized.map((a) => a.size));
		const bad = sized.find((a) => a.size !== n && a.size !== 1);
		if (bad) throw new PixelSyntaxError(`${fn} can't mix a ${sizeName(n)} and a ${sizeName(bad.size)}; make them the same size`, line);
		return { k: 'call', fn, args, size: spec.result === 'scalar' ? 1 : n, line };
	};

	// Statements --------------------------------------------------------------
	const parseControl = (line: number) => {
		const nameTok = peek();
		const name = ident('a control name, e.g. control speed: number = 1');
		checkNewName(name, nameTok.line);
		declaring = name;
		expectOp(':', `after the control name (control ${name}: number = 1)`);
		const typeTok = peek();
		const type = ident(`a control type (${TYPE_NAMES.join(', ')})`) as PixelControlType;
		if (!TYPE_NAMES.includes(type)) throw new PixelSyntaxError(`"${type}" isn't a control type; use ${TYPE_NAMES.join(', ')}`, typeTok.line);
		expectOp('=', `and a default value (control ${name}: ${type} = …)`);
		let def: EffectValue;
		if (type === 'number') def = signedNumber('a number');
		else if (type === 'bool') {
			const t = next();
			if (t.t !== 'id' || (t.v !== 'true' && t.v !== 'false')) throw new PixelSyntaxError(`a bool control's default is true or false, not ${describeTok(t)}`, t.line);
			def = t.v === 'true';
		} else if (type === 'color') {
			const t = next();
			if (t.t !== 'color' || t.v.length !== 3) throw new PixelSyntaxError(`a colour control's default is #rrggbb, not ${describeTok(t)}`, t.line);
			def = '#' + t.v.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
		} else {
			const t = next();
			if (t.t !== 'id' || t.v !== 'vec2') throw new PixelSyntaxError(`a vec2 control's default is vec2(x, y), not ${describeTok(t)}`, t.line);
			expectOp('(', 'after vec2');
			const x = signedNumber('a number');
			expectOp(',', 'between x and y');
			const y = signedNumber('a number');
			expectOp(')', 'to close vec2(');
			def = [x, y];
		}
		let min: number | undefined;
		let max: number | undefined;
		const r = peek();
		if (r.t === 'id' && r.v === 'range') {
			next();
			if (type === 'color' || type === 'bool') throw new PixelSyntaxError(`a ${type} control has no range`, r.line);
			min = signedNumber('the lowest value after range');
			max = signedNumber('the highest value after range');
			if (!(min < max)) throw new PixelSyntaxError(`range ${min} ${max} is empty; write the lowest value first`, r.line);
			const vals = Array.isArray(def) ? def : [def as number];
			if (vals.some((v) => (v as number) < min! || (v as number) > max!)) throw new PixelSyntaxError(`the default ${JSON.stringify(def)} is outside range ${min} ${max}`, r.line);
		}
		const size = type === 'color' ? 3 : type === 'vec2' ? 2 : 1;
		scope.set(name, { size, kind: 'control', line });
		controls.push({ name, type, default: def, ...(min !== undefined ? { min, max } : {}), description: comments.get(line) || `The ${name} control.`, line });
	};

	while (p < toks.length) {
		const t = peek();
		if (t.t === 'nl') {
			p++;
			continue;
		}
		const line = t.line;
		declaring = null;
		try {
			if (out) throw new PixelSyntaxError(`"out = …" must be the last line; move this line above line ${out.line}`, line);
			if (t.t === 'id' && t.v === 'control') {
				next();
				if (lets.length) throw new PixelSyntaxError(`put control lines before the first let (line ${lets[0].line})`, line);
				parseControl(line);
			} else if (t.t === 'id' && t.v === 'let') {
				next();
				const nameTok = peek();
				const name = ident('a name after let, e.g. let d = length(uv)');
				checkNewName(name, nameTok.line);
				declaring = name;
				expectOp('=', `after let ${name}`);
				const expr = parseExpr();
				scope.set(name, { size: expr.size, kind: 'let', line });
				lets.push({ name, expr, line });
			} else if (t.t === 'id' && t.v === 'out') {
				next();
				expectOp('=', 'after out');
				const expr = parseExpr();
				if (expr.size === 2) throw new PixelSyntaxError('out is a number (grey), a vec3 (colour) or a vec4 (colour and alpha), not a vec2', line);
				out = { expr, line };
			} else {
				throw new PixelSyntaxError(`a line starts with control, let or out, not ${describeTok(t)}`, line);
			}
			const end = peek();
			if (end.t !== 'nl') throw new PixelSyntaxError(`unexpected ${describeTok(end)}; put one statement on each line`, end.line);
		} catch (e) {
			if (!(e instanceof PixelSyntaxError)) throw e;
			if (e.message) issues.push({ severity: 'error', line: e.line, message: e.message });
			else if (!issues.some((i) => i.severity === 'error')) issues.push({ severity: 'error', line: e.line, message: 'this line uses a name whose own line has an error' });
			if (declaring) poisoned.add(declaring);
			while (p < toks.length && toks[p].t !== 'nl') p++;
		}
	}

	if (!out && !issues.some((i) => i.severity === 'error')) {
		const lastLine = source.split('\n').length;
		issues.push({ severity: 'error', line: lastLine, message: 'nothing is drawn: end with a line such as out = vec3(uv, 0.5)' });
	}
	if (issues.some((i) => i.severity === 'error') || !out) return { ok: false, issues };

	const cost = lets.reduce((s, l) => s + exprCost(l.expr), 0) + exprCost(out.expr);
	if (cost > lim.maxCost) {
		return { ok: false, issues: [...issues, { severity: 'error', line: out.line, message: `the program does ${cost} steps per pixel; the limit is ${lim.maxCost}. Share work with let, or simplify` }] };
	}
	for (const c of controls) if (!used.has(c.name)) issues.push({ severity: 'warning', line: c.line, message: `control "${c.name}" isn't used` });
	for (const l of lets) if (!used.has(l.name)) issues.push({ severity: 'warning', line: l.line, message: `"${l.name}" isn't used` });
	return { ok: true, program: { controls, lets, out: out.expr, cost }, issues };
}

/** Steps an expression takes per pixel. */
export function exprCost(e: PixelExpr): number {
	switch (e.k) {
		case 'num':
		case 'const':
		case 'var':
			return 0;
		case 'neg':
		case 'swizzle':
			return 1 + exprCost(e.a);
		case 'bin':
			return 1 + exprCost(e.a) + exprCost(e.b);
		case 'call':
			return (e.fn === 'noise' ? 4 : 1) + e.args.reduce((s, a) => s + exprCost(a), 0);
	}
}

// ---------------------------------------------------------------------------
// Controls as an effect description
// ---------------------------------------------------------------------------

const HEX_PATTERN = '^#[0-9a-fA-F]{6}$';

/** The JSON Schema of one control. */
export function pixelControlSchema(c: PixelControl): Record<string, unknown> {
	switch (c.type) {
		case 'number':
			return { type: 'number', description: c.description, ...(c.min !== undefined ? { minimum: c.min, maximum: c.max } : {}) };
		case 'bool':
			return { type: 'boolean', description: c.description };
		case 'color':
			return { type: 'string', pattern: HEX_PATTERN, description: `${c.description} (#rrggbb)` };
		case 'vec2':
			return {
				type: 'array',
				description: `${c.description} ([x, y])`,
				minItems: 2,
				maxItems: 2,
				items: { type: 'number', description: 'x or y.', ...(c.min !== undefined ? { minimum: c.min, maximum: c.max } : {}) }
			};
	}
}

// ---------------------------------------------------------------------------
// CPU evaluation
// ---------------------------------------------------------------------------

/** The integer hash behind `hash` and `noise` (identical in Swift and MSL). */
export function pixelHash(x: number, y: number): number {
	const ix = Math.floor(Math.max(-1e9, Math.min(1e9, x))) | 0;
	const iy = Math.floor(Math.max(-1e9, Math.min(1e9, y))) | 0;
	let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841)) >>> 0;
	h = (h ^ (h >>> 13)) >>> 0;
	h = Math.imul(h, 0x5bd1e995) >>> 0;
	h = (h ^ (h >>> 15)) >>> 0;
	return h / 4294967296;
}

export function pixelNoise(x: number, y: number): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	const a = pixelHash(ix, iy);
	const b = pixelHash(ix + 1, iy);
	const c = pixelHash(ix, iy + 1);
	const d = pixelHash(ix + 1, iy + 1);
	const top = a + (b - a) * ux;
	const bottom = c + (d - c) * ux;
	return top + (bottom - top) * uy;
}

const unary: Record<string, (x: number) => number> = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	sqrt: (x) => (x > 0 ? Math.sqrt(x) : 0),
	exp: Math.exp,
	log: Math.log,
	abs: Math.abs,
	sign: (x) => (x > 0 ? 1 : x < 0 ? -1 : 0),
	floor: Math.floor,
	ceil: Math.ceil,
	fract: (x) => x - Math.floor(x)
};
const fmod = (x: number, y: number) => x - y * Math.floor(x / y);
const binary: Record<string, (a: number, b: number) => number> = {
	'+': (a, b) => a + b,
	'-': (a, b) => a - b,
	'*': (a, b) => a * b,
	'/': (a, b) => a / b,
	'%': fmod,
	mod: fmod,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	atan: Math.atan2,
	step: (edge, x) => (x < edge ? 0 : 1),
	'<': (a, b) => (a < b ? 1 : 0),
	'<=': (a, b) => (a <= b ? 1 : 0),
	'>': (a, b) => (a > b ? 1 : 0),
	'>=': (a, b) => (a >= b ? 1 : 0),
	'==': (a, b) => (a === b ? 1 : 0),
	'!=': (a, b) => (a !== b ? 1 : 0)
};
const ternary: Record<string, (a: number, b: number, c: number) => number> = {
	clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
	mix: (a, b, t) => a + (b - a) * t,
	smoothstep: (lo, hi, x) => {
		const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
		return t * t * (3 - 2 * t);
	},
	select: (c, a, b) => (c > 0.5 ? a : b)
};

/** A program ready to run per pixel on the CPU. */
export interface PixelEvaluator {
	/** Draws the program into straight-alpha RGBA8 (`out` must hold width × height × 4 bytes). */
	render(width: number, height: number, timeMs: number, values: EffectValues, out: Uint8ClampedArray): void;
}

/** A control value as numbers for the evaluator (`#rrggbb` → 0..1 per channel, bool → 0 or 1). */
export function pixelControlNumbers(c: PixelControl, value: EffectValue | undefined): number[] {
	const v = value ?? c.default;
	switch (c.type) {
		case 'number':
			return [typeof v === 'number' ? v : (c.default as number)];
		case 'bool':
			return [v === true ? 1 : 0];
		case 'color': {
			const hex = typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : (c.default as string);
			return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
		}
		case 'vec2':
			return Array.isArray(v) && v.length === 2 ? (v as number[]).slice() : (c.default as number[]).slice();
	}
}

/**
 * Compiles a checked program into register operations: every expression node writes its result
 * into its own slots of one `Float64Array`, in the order they depend on each other.
 */
export function createPixelEvaluator(program: PixelProgram): PixelEvaluator {
	let top = 0;
	const alloc = (n: number) => {
		const at = top;
		top += n;
		return at;
	};
	const named = new Map<string, number>();
	for (const name of Object.keys(PIXEL_BUILTINS)) named.set(name, alloc(PIXEL_BUILTINS[name].size));
	const controlSlots = program.controls.map((c) => {
		const at = alloc(c.type === 'color' ? 3 : c.type === 'vec2' ? 2 : 1);
		named.set(c.name, at);
		return at;
	});
	const ops: ((r: Float64Array) => void)[] = [];

	const emit = (e: PixelExpr): number => {
		switch (e.k) {
			case 'num': {
				const at = alloc(1);
				const v = e.v;
				ops.push((r) => {
					r[at] = v;
				});
				return at;
			}
			case 'const': {
				const at = alloc(e.size);
				const v = e.v;
				ops.push((r) => {
					for (let i = 0; i < v.length; i++) r[at + i] = v[i];
				});
				return at;
			}
			case 'var':
				return named.get(e.name)!;
			case 'neg': {
				const a = emit(e.a);
				const at = alloc(e.size);
				const n = e.size;
				ops.push((r) => {
					for (let i = 0; i < n; i++) r[at + i] = -r[a + i];
				});
				return at;
			}
			case 'swizzle': {
				const a = emit(e.a);
				const at = alloc(e.size);
				const comps = e.comps;
				ops.push((r) => {
					for (let i = 0; i < comps.length; i++) r[at + i] = r[a + comps[i]];
				});
				return at;
			}
			case 'bin': {
				const a = emit(e.a);
				const b = emit(e.b);
				return each(binary[e.op], [a, b], [e.a.size, e.b.size], e.size);
			}
			case 'call': {
				const args = e.args.map(emit);
				const sizes = e.args.map((x) => x.size);
				return call(e.fn, args, sizes, e.size);
			}
		}
	};

	const each = (f: (...xs: number[]) => number, args: number[], sizes: number[], n: number): number => {
		const at = alloc(n);
		const steps = sizes.map((s) => (s === 1 ? 0 : 1));
		if (args.length === 1) {
			const [a] = args;
			const [sa] = steps;
			ops.push((r) => {
				for (let i = 0; i < n; i++) r[at + i] = f(r[a + i * sa]);
			});
		} else if (args.length === 2) {
			const [a, b] = args;
			const [sa, sb] = steps;
			ops.push((r) => {
				for (let i = 0; i < n; i++) r[at + i] = f(r[a + i * sa], r[b + i * sb]);
			});
		} else {
			const [a, b, c] = args;
			const [sa, sb, sc] = steps;
			ops.push((r) => {
				for (let i = 0; i < n; i++) r[at + i] = f(r[a + i * sa], r[b + i * sb], r[c + i * sc]);
			});
		}
		return at;
	};

	const call = (fn: string, args: number[], sizes: number[], n: number): number => {
		if (fn in unary && args.length === 1) return each(unary[fn], args, sizes, n);
		if (fn in binary) return each(binary[fn], args, sizes, n);
		if (fn in ternary) {
			if (fn === 'select') {
				const at = alloc(n);
				const [c, a, b] = args;
				const sa = sizes[1] === 1 ? 0 : 1;
				const sb = sizes[2] === 1 ? 0 : 1;
				ops.push((r) => {
					const pick = r[c] > 0.5;
					for (let i = 0; i < n; i++) r[at + i] = pick ? r[a + i * sa] : r[b + i * sb];
				});
				return at;
			}
			return each(ternary[fn], args, sizes, n);
		}
		const at = alloc(n);
		const [a, b] = args;
		const sa = sizes[0];
		switch (fn) {
			case 'length':
				ops.push((r) => {
					let s = 0;
					for (let i = 0; i < sa; i++) s += r[a + i] * r[a + i];
					r[at] = Math.sqrt(s);
				});
				break;
			case 'distance': {
				const m = Math.max(sizes[0], sizes[1]);
				const s0 = sizes[0] === 1 ? 0 : 1;
				const s1 = sizes[1] === 1 ? 0 : 1;
				ops.push((r) => {
					let s = 0;
					for (let i = 0; i < m; i++) {
						const d = r[a + i * s0] - r[b + i * s1];
						s += d * d;
					}
					r[at] = Math.sqrt(s);
				});
				break;
			}
			case 'dot': {
				const m = Math.max(sizes[0], sizes[1]);
				const s0 = sizes[0] === 1 ? 0 : 1;
				const s1 = sizes[1] === 1 ? 0 : 1;
				ops.push((r) => {
					let s = 0;
					for (let i = 0; i < m; i++) s += r[a + i * s0] * r[b + i * s1];
					r[at] = s;
				});
				break;
			}
			case 'normalize':
				ops.push((r) => {
					let s = 0;
					for (let i = 0; i < n; i++) s += r[a + i] * r[a + i];
					const len = Math.sqrt(s);
					for (let i = 0; i < n; i++) r[at + i] = len > 0 ? r[a + i] / len : 0;
				});
				break;
			case 'hash':
				ops.push((r) => {
					r[at] = pixelHash(r[a], r[a + 1]);
				});
				break;
			case 'noise':
				ops.push((r) => {
					r[at] = pixelNoise(r[a], r[a + 1]);
				});
				break;
			case 'vec2':
			case 'vec3':
			case 'vec4': {
				if (args.length === 1 && sizes[0] === 1) {
					ops.push((r) => {
						for (let i = 0; i < n; i++) r[at + i] = r[a];
					});
				} else {
					const parts = args.map((x, k) => [x, sizes[k]] as const);
					ops.push((r) => {
						let o = at;
						for (const [x, s] of parts) for (let i = 0; i < s; i++) r[o++] = r[x + i];
					});
				}
				break;
			}
			default:
				throw new Error(`no evaluator for ${fn}`);
		}
		return at;
	};

	for (const l of program.lets) named.set(l.name, emit(l.expr));
	const outAt = emit(program.out);
	const outSize = program.out.size;
	const regs = new Float64Array(top);
	const B = named;
	const uv = B.get('uv')!;
	const pos = B.get('pos')!;
	const sz = B.get('size')!;
	const tm = B.get('time')!;

	const byte = (v: number) => (v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0);

	return {
		render(width, height, timeMs, values, out) {
			regs[sz] = width;
			regs[sz + 1] = height;
			regs[tm] = timeMs / 1000;
			regs[B.get('PI')!] = Math.PI;
			regs[B.get('TAU')!] = Math.PI * 2;
			program.controls.forEach((c, i) => {
				const v = pixelControlNumbers(c, values[c.name]);
				for (let k = 0; k < v.length; k++) regs[controlSlots[i] + k] = v[k];
			});
			let o = 0;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					regs[pos] = x + 0.5;
					regs[pos + 1] = y + 0.5;
					regs[uv] = (x + 0.5) / width;
					regs[uv + 1] = (y + 0.5) / height;
					for (let k = 0; k < ops.length; k++) ops[k](regs);
					if (outSize === 1) {
						const g = byte(regs[outAt]);
						out[o] = g;
						out[o + 1] = g;
						out[o + 2] = g;
						out[o + 3] = 255;
					} else {
						out[o] = byte(regs[outAt]);
						out[o + 1] = byte(regs[outAt + 1]);
						out[o + 2] = byte(regs[outAt + 2]);
						out[o + 3] = outSize === 4 ? byte(regs[outAt + 3]) : 255;
					}
					o += 4;
				}
			}
		}
	};
}
