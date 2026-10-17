// Streaming follows Ursula's MermaidStreamingView and src/graph/view.ts (`blendLayout`: marks are matched by id,
// new ones appear at their target, missing ones drop out; layouts are adopted on a throttle and the scale is held
// steady until the source is complete).
import { chartFromMermaid } from './mermaid.js';
import { normalizeChartSpec } from './spec.js';
import type { ChartIssue, ChartMark, ChartScene, ChartSpec } from './types.js';

/**
 * Reads JSON that is still arriving: closes open strings, arrays and objects and drops a
 * dangling key or comma, so `{"type":"bar","series":[{"name":"A","values":[1,2` reads as far
 * as it goes. Returns `undefined` when nothing usable has arrived yet.
 */
export function parsePartialChartJson(text: string): unknown {
	const src = text.trim();
	if (!src) return undefined;
	try {
		return JSON.parse(src);
	} catch {
		// fall through
	}
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	let out = '';
	for (const ch of src) {
		out += ch;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
		else if (ch === '}' || ch === ']') stack.pop();
	}
	if (inString) out += '"';
	// Drop what cannot end a value: a trailing comma, colon, key without value or partial literal.
	for (let attempt = 0; attempt < 6; attempt++) {
		const trimmed = out.replace(/\s+$/, '');
		const candidate = trimmed + [...stack].reverse().join('');
		try {
			return JSON.parse(candidate);
		} catch {
			const next = trimmed
				.replace(/,\s*$/, '')
				.replace(/(?:,|\{)\s*"[^"]*"\s*:?\s*$/, (m) => (m.trim().startsWith('{') ? '{' : ''))
				.replace(/:\s*$/, ': null')
				.replace(/(?<=[\[,:]\s*)(-|tr?u?|fa?l?s?|nu?l?)$/, '')
				.replace(/(?<=[\[,:]\s*)(-?\d+\.)$/, (m) => m.slice(0, -1));
			if (next === trimmed) break;
			out = next;
		}
	}
	return undefined;
}

export type ChartStreamFormat = 'auto' | 'mermaid' | 'json';

export interface ChartStreamResult {
	/** The chart as far as it has arrived, or `null` before anything can be drawn. */
	spec: ChartSpec | null;
	issues: ChartIssue[];
	/**
	 * The value range to lay out with while incomplete: it only grows, so the axis does not
	 * jump as values arrive. `null` once complete (the chart's own scale takes over).
	 */
	valueDomain: { min: number; max: number } | null;
}

/**
 * Turns a chart source that is still being written (Mermaid or a JSON spec, e.g. streamed
 * from a model) into drawable specs. Series appear once their values start, axis bounds only
 * grow until `complete`, and parse problems are reported only once the source is complete.
 */
export class ChartStream {
	private lo = Infinity;
	private hi = -Infinity;
	private last: ChartSpec | null = null;

	constructor(private readonly format: ChartStreamFormat = 'auto') {}

	/** Reads the source so far. `complete` when nothing more will arrive. */
	update(source: string, complete = false): ChartStreamResult {
		const text = source.replace(/^\s*```(?:mermaid|json)?\s*\n?/, '').replace(/```\s*$/, '');
		const format = this.format === 'auto' ? (/^\s*[[{]/.test(text) ? 'json' : 'mermaid') : this.format;
		let spec: ChartSpec | null = null;
		let issues: ChartIssue[] = [];
		if (format === 'json') {
			const value = complete ? safeParse(text) : parsePartialChartJson(text);
			if (value !== undefined) {
				const read = normalizeChartSpec(value);
				spec = read.spec;
				issues = complete ? read.issues : [];
			}
		} else {
			const read = chartFromMermaid(text, { partial: !complete });
			if (read.family) {
				spec = read.spec;
				issues = complete ? read.issues : [];
			}
		}
		if (spec && !spec.series.some((s) => s.values.some((v) => v !== null))) spec = complete ? spec : this.last;
		if (spec) this.last = spec;
		if (spec) {
			for (const s of spec.series) for (const v of s.values) if (v !== null && Number.isFinite(v)) (this.lo = Math.min(this.lo, v)), (this.hi = Math.max(this.hi, v));
		}
		const valueDomain = !complete && Number.isFinite(this.lo) && this.hi > this.lo ? { min: Math.min(0, this.lo), max: this.hi } : null;
		return { spec, issues, valueDomain };
	}

	/** Forgets the axis bounds (a new source). */
	reset(): void {
		this.lo = Infinity;
		this.hi = -Infinity;
		this.last = null;
	}
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return parsePartialChartJson(text);
	}
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Paths with the same commands blend number by number; others switch at the end. */
function blendPath(a: string, b: string, t: number): string {
	const na = a.match(/-?\d*\.?\d+(?:e-?\d+)?/g);
	const nb = b.match(/-?\d*\.?\d+(?:e-?\d+)?/g);
	if (!na || !nb || na.length !== nb.length || a.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, '#') !== b.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, '#')) return t < 1 ? a : b;
	let i = 0;
	return b.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, () => {
		const v = mix(Number(na[i]), Number(nb[i]), t);
		i++;
		return String(Math.round(v * 100) / 100);
	});
}

/**
 * A scene between two scenes, for animating changes (streamed data arriving, an agent's
 * edit): marks are matched by `key`; numbers and same-shaped paths move from `from` to `to`;
 * new marks fade in and marks that are gone are dropped. `t` runs from 0 to 1.
 */
export function blendChartScenes(from: ChartScene | null, to: ChartScene, t: number): ChartScene {
	if (!from || t >= 1) return to;
	const k = Math.max(0, Math.min(1, t));
	const before = new Map(from.marks.map((m) => [m.key, m]));
	const marks: ChartMark[] = to.marks.map((m) => {
		const a = before.get(m.key);
		if (!a || a.kind !== m.kind) return { ...m, opacity: (m.opacity ?? 1) * k };
		switch (m.kind) {
			case 'rect': {
				const p = a as typeof m;
				return { ...m, x: mix(p.x, m.x, k), y: mix(p.y, m.y, k), width: mix(p.width, m.width, k), height: mix(p.height, m.height, k) };
			}
			case 'circle': {
				const p = a as typeof m;
				return { ...m, cx: mix(p.cx, m.cx, k), cy: mix(p.cy, m.cy, k), r: mix(p.r, m.r, k) };
			}
			case 'line': {
				const p = a as typeof m;
				return { ...m, x1: mix(p.x1, m.x1, k), y1: mix(p.y1, m.y1, k), x2: mix(p.x2, m.x2, k), y2: mix(p.y2, m.y2, k) };
			}
			case 'text': {
				const p = a as typeof m;
				return { ...m, x: mix(p.x, m.x, k), y: mix(p.y, m.y, k) };
			}
			case 'path':
				return { ...m, d: blendPath((a as typeof m).d, m.d, k) };
		}
	});
	return { ...to, marks };
}

/** Ease-out cubic, for tweens. */
export const easeChartTween = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
