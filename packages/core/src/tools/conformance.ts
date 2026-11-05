/**
 * Conformance scenarios: a recorded sequence of tool calls with what each one returned, so
 * another implementation of an editor (the Swift port, #533) can replay the same calls and check
 * it gets the same results, documents and pixels. `@pixerate/conformance` holds the scenarios
 * (`domains/<domain>/fixtures/*.json`); `scripts/record-conformance.mjs` records them from this
 * core and a core test replays them.
 *
 * Results are compared after {@link normalizeConformanceValue}: ids an implementation generates
 * (from a clock, say) become `@1`, `@2`, … in the order they are first seen, and binary payloads
 * become `"<binary>"`, so neither the id format nor the PNG encoder is part of the contract. Ids
 * that come from counters or names (`s1`, `pad1`, `ink-pen`) stay as they are. Every implementation applies the same rules (written
 * out in the package README).
 */

import type { McpToolResult } from './registry.js';

/** One tool call of a scenario and, once recorded, what it returned. */
export interface ConformanceStep {
	/** Tool name, unprefixed (`paint_stroke`). */
	tool: string;
	/** Arguments. A string `@n` is replaced by the id that `@n` stands for. */
	arguments?: Record<string, unknown>;
	/** Also compare the saved document after this call. */
	document?: boolean;
	/**
	 * Also compare the rendered pixels after this call (`paper: false` leaves the paper out;
	 * `tolerance` loosens what another implementation is held to for this snapshot).
	 */
	pixels?: boolean | { paper?: boolean; tolerance?: { maxDelta?: number; meanDelta?: number } };
	/**
	 * Also compare the render data after this call: what the canvases draw, for editors whose
	 * picture is data rather than pixels (the vector editor's scene). Normalized like a result.
	 */
	render?: boolean;
	/**
	 * Parts of the result left out of the comparison because they describe this implementation
	 * rather than the contract (the wet engine's backend): JSON pointers like `/backend`, where a
	 * `*` segment stands for every array element or object member.
	 */
	ignore?: string[];
	/** Recorded results, written by the recorder. */
	expect?: ConformanceExpectation;
}

export interface ConformanceExpectation {
	/** The normalized `structuredContent`, or `{ error: { code, message, details? } }` for a failed call. */
	result: unknown;
	isError?: true;
	document?: unknown;
	/** The normalized render data (steps with `render: true`). */
	render?: unknown;
	pixels?: ConformancePixels;
}

/** A pixel snapshot: the PNG next to the scenario plus how close another implementation must be. */
export interface ConformancePixels {
	/** PNG file, relative to the scenario file. */
	file: string;
	width: number;
	height: number;
	/** SHA-256 of the RGBA bytes, hex. This core matches it exactly. */
	sha256: string;
	/** Largest difference allowed in any channel of any pixel (0–255). */
	maxDelta: number;
	/** Largest mean difference allowed over all channels. */
	meanDelta: number;
}

export interface ConformanceScenario {
	$schema?: string;
	/** Unique kebab-case id within the domain; also the file name. */
	id: string;
	description: string;
	/** Host options, such as the canvas size. */
	setup?: Record<string, unknown>;
	steps: ConformanceStep[];
	/** Reasons an implementation skips the whole scenario, by implementation (`swift`). */
	skip?: Record<string, string>;
}

/** What a scenario runs against: a tool registry plus ways to read the document and pixels. */
export interface ConformanceHost {
	callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	document(): unknown;
	pixels(options: { paper?: boolean }): { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
	/**
	 * What the canvases draw, as plain data (the vector editor's scene render data), for steps with
	 * `render: true`. Editors without render data leave it out.
	 */
	render?(): unknown;
	/** Whether a string is an id this implementation generated in its own format (default: none). */
	isGeneratedId?(value: string): boolean;
	dispose?(): void;
}

/** What one step produced, normalized (pixels are raw RGBA for the caller to hash or encode). */
export interface ConformanceStepOutput {
	result: unknown;
	isError: boolean;
	document?: unknown;
	render?: unknown;
	pixels?: { width: number; height: number; data: Uint8Array };
}

/** Maps real ids to `@n` placeholders and back, across a whole scenario. */
export class ConformanceIds {
	private readonly toPlaceholder = new Map<string, string>();
	private readonly fromPlaceholder = new Map<string, string>();

	/** The placeholder for `id`, assigning the next one when it is new. */
	add(id: string): string {
		let placeholder = this.toPlaceholder.get(id);
		if (!placeholder) {
			placeholder = `@${this.toPlaceholder.size + 1}`;
			this.toPlaceholder.set(id, placeholder);
			this.fromPlaceholder.set(placeholder, id);
		}
		return placeholder;
	}

	placeholder(id: string): string | undefined {
		return this.toPlaceholder.get(id);
	}

	/** `text` with every known id in it replaced by its placeholder (longest ids first). */
	replaceWithin(text: string): string {
		const exact = this.toPlaceholder.get(text);
		if (exact) return exact;
		let out = text;
		for (const id of [...this.toPlaceholder.keys()].sort((a, b) => b.length - a.length)) {
			if (out.includes(id)) out = out.split(id).join(this.toPlaceholder.get(id)!);
		}
		return out;
	}

	/** The real id a placeholder stands for. */
	resolve(placeholder: string): string | undefined {
		return this.fromPlaceholder.get(placeholder);
	}
}

const PLACEHOLDER = /^@[1-9][0-9]*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;
/** Strings at least this long made only of base64 characters are binary payloads. */
export const CONFORMANCE_BINARY_MIN_LENGTH = 200;

type IdTest = (value: string) => boolean;

function isBinary(value: string): boolean {
	return value.startsWith('data:') || (value.length >= CONFORMANCE_BINARY_MIN_LENGTH && BASE64.test(value));
}

function sortedKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Collects generated ids in a fixed order: depth first, object keys sorted by UTF-16 code units. */
function collectIds(value: unknown, ids: ConformanceIds, isId: IdTest): void {
	if (typeof value === 'string') {
		if (isId(value)) ids.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectIds(item, ids, isId);
		return;
	}
	if (value && typeof value === 'object') {
		for (const k of sortedKeys(value as Record<string, unknown>)) {
			if (isId(k)) ids.add(k);
			collectIds((value as Record<string, unknown>)[k], ids, isId);
		}
	}
}

function replaceIds(value: unknown, ids: ConformanceIds): unknown {
	if (typeof value === 'string') return isBinary(value) ? '<binary>' : TIMESTAMP.test(value) ? '<time>' : ids.replaceWithin(value);
	if (Array.isArray(value)) return value.map((item) => replaceIds(item, ids));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of sortedKeys(value as Record<string, unknown>)) out[ids.replaceWithin(k)] = replaceIds((value as Record<string, unknown>)[k], ids);
		return out;
	}
	return value;
}

/**
 * A value as scenarios store it:
 * 1. Every string value or object key the implementation generated as an id (`isGeneratedId`) is
 *    numbered `@1`, `@2`, … in the order first seen, walking depth first with object keys sorted
 *    (each key before its value); the numbering carries across the scenario's steps.
 * 2. Every known id in a string or object key, whole or inside a longer string (an error message),
 *    becomes its placeholder; longer ids are replaced first.
 * 3. A string starting with `data:`, or at least 200 characters of base64, becomes `"<binary>"`.
 * 4. An ISO 8601 date-time string (`2026-11-04T01:06:52.993Z`) becomes `"<time>"`: clocks differ.
 * 5. Object keys are sorted; `undefined` values are dropped (as JSON would).
 */
export function normalizeConformanceValue(value: unknown, ids: ConformanceIds, isGeneratedId: IdTest = () => false): unknown {
	const json = value === undefined ? null : JSON.parse(JSON.stringify(value));
	collectIds(json, ids, (v) => !PLACEHOLDER.test(v) && isGeneratedId(v));
	return replaceIds(json, ids);
}

/** `value` without the members at `paths` (`/a/b`, `*` for every element or member). */
export function omitConformancePaths(value: unknown, paths: readonly string[]): unknown {
	let out = value === undefined ? null : JSON.parse(JSON.stringify(value));
	for (const path of paths) out = omitPath(out, path.split('/').slice(1));
	return out;
}

function omitPath(value: unknown, parts: string[]): unknown {
	if (!value || typeof value !== 'object' || parts.length === 0) return value;
	const [head, ...rest] = parts;
	if (Array.isArray(value)) {
		if (head === '*') return value.map((item) => omitPath(item, rest));
		const i = Number(head);
		if (!Number.isInteger(i) || i < 0 || i >= value.length) return value;
		if (rest.length === 0) return value.filter((_, j) => j !== i);
		return value.map((item, j) => (j === i ? omitPath(item, rest) : item));
	}
	const object = value as Record<string, unknown>;
	const keys = head === '*' ? Object.keys(object) : head in object ? [head] : [];
	for (const key of keys) {
		if (rest.length === 0) delete object[key];
		else object[key] = omitPath(object[key], rest);
	}
	return object;
}

/** Arguments with each `@n` placeholder string replaced by the id it stands for. */
export function resolveConformanceArguments(value: unknown, ids: ConformanceIds): unknown {
	if (typeof value === 'string' && PLACEHOLDER.test(value)) {
		const id = ids.resolve(value);
		if (id === undefined) throw new Error(`Placeholder ${value} is used before any result returned that id.`);
		return id;
	}
	if (Array.isArray(value)) return value.map((item) => resolveConformanceArguments(item, ids));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = resolveConformanceArguments(v, ids);
		return out;
	}
	return value;
}

/** The comparable part of a tool result: `structuredContent`, or the error's code, message and details. */
export function conformanceResult(result: McpToolResult): { value: unknown; isError: boolean } {
	if (result.isError) {
		const error = (result.structuredContent?.error ?? {}) as { code?: string; message?: string; details?: unknown };
		const value = { code: error.code ?? 'tool_failed', message: error.message ?? resultText(result) ?? '', ...(error.details !== undefined ? { details: error.details } : {}) };
		return { value: { error: value }, isError: true };
	}
	if (result.structuredContent !== undefined) return { value: result.structuredContent, isError: false };
	const text = resultText(result);
	if (text === undefined) return { value: null, isError: false };
	try {
		return { value: JSON.parse(text), isError: false };
	} catch {
		return { value: text, isError: false };
	}
}

function resultText(result: McpToolResult): string | undefined {
	for (const content of result.content) {
		if (content.type === 'text' && 'text' in content && typeof content.text === 'string') return content.text;
	}
	return undefined;
}

/**
 * Numbers within this relative difference compare equal: maths functions (`Math.sin`, `Math.cos`)
 * may differ in their last bits between CPUs (x64 and arm64 fuse multiply-adds differently), so a
 * recording made on one machine is replayed on another. The Swift runner uses the same tolerance.
 */
export const CONFORMANCE_NUMBER_TOLERANCE = 1e-9;

/** Whether two normalized values match: the same structure and strings, numbers within tolerance. */
export function conformanceValuesMatch(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= CONFORMANCE_NUMBER_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => conformanceValuesMatch(x, b[i]));
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const ka = Object.keys(a), kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => k in (b as object) && conformanceValuesMatch((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
	}
	return a === b;
}

/** Runs a scenario's calls in order against a fresh host and returns what each step produced. */
export async function runConformanceScenario(scenario: ConformanceScenario, host: ConformanceHost): Promise<ConformanceStepOutput[]> {
	const ids = new ConformanceIds();
	const isId = host.isGeneratedId?.bind(host);
	const outputs: ConformanceStepOutput[] = [];
	try {
		for (const step of scenario.steps) {
			const args = resolveConformanceArguments(step.arguments ?? {}, ids) as Record<string, unknown>;
			const { value, isError } = conformanceResult(await host.callTool(step.tool, args));
			const result = normalizeConformanceValue(value, ids, isId);
			const output: ConformanceStepOutput = { result: step.ignore ? omitConformancePaths(result, step.ignore) : result, isError };
			if (step.document) output.document = normalizeConformanceValue(host.document(), ids, isId);
			if (step.render) {
				if (!host.render) throw new Error(`Step ${outputs.length + 1} (${step.tool}) asks for render data, which this host does not have.`);
				output.render = normalizeConformanceValue(host.render(), ids, isId);
			}
			if (step.pixels) {
				const image = host.pixels({ paper: typeof step.pixels === 'object' ? step.pixels.paper : undefined });
				output.pixels = { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) };
			}
			outputs.push(output);
		}
	} finally {
		host.dispose?.();
	}
	return outputs;
}
