import type { McpToolDefinition, ToolsetInfo } from './registry.js';
import { baseToolName } from './registry.js';

/** A tool as `search_tools` ranks it. */
export interface ToolSearchResult {
	/** Exposed tool name, to call or to pass to `enable_tools`. */
	name: string;
	toolset: string;
	title?: string;
	/** The first sentence of the tool's description. */
	summary: string;
	readOnly: boolean;
	score: number;
}

export interface ToolSearchOptions {
	/** Only search this toolset. */
	toolset?: string;
	/** Maximum results (default 10). */
	limit?: number;
}

// Words that say nothing about which tool to pick.
const STOP_WORDS = new Set(
	'a an and are as at be by can do for from has have how i in into is it its me my of on or our so than that the their them then there these this to up us use using want we what when which will with you your please make let'.split(
		' '
	)
);

/** Crude English stemmer: enough to match "layers" to "layer" and "adding" to "add". */
function stem(word: string): string {
	if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
	if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
	if (word.length > 4 && word.endsWith('es') && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
	if (word.length > 2 && word.endsWith('s') && !/(ss|us|is|as)$/.test(word)) return word.slice(0, -1);
	return word;
}

// British spellings, so "colour" finds "color" and the other way round.
const SPELLING: Record<string, string> = { colour: 'color', grey: 'gray', centre: 'center', organise: 'organize', normalise: 'normalize' };

/**
 * Words people use for what tools call something else. A query word also matches its
 * synonyms, at half weight. Keep it to general editing vocabulary, not single tools.
 */
const SYNONYMS: Record<string, string[]> = {
	link: ['connect', 'edge'],
	join: ['connect', 'merge'],
	arrow: ['edge', 'connect'],
	step: ['node'],
	box: ['node', 'shape'],
	flowchart: ['diagram'],
	graph: ['chart', 'diagram'],
	plot: ['chart'],
	photo: ['image'],
	picture: ['image'],
	footage: ['video', 'clip'],
	timeline: ['track', 'clip', 'video'],
	recording: ['audio', 'video'],
	sound: ['audio'],
	quiet: ['silence'],
	silent: ['silence'],
	delete: ['remove'],
	erase: ['remove', 'clear'],
	screenshot: ['capture', 'view'],
	snapshot: ['capture'],
	tidy: ['layout', 'arrange'],
	arrange: ['layout'],
	organize: ['layout', 'arrange'],
	number: ['value', 'data'],
	figure: ['value', 'data'],
	cost: ['estimate', 'credit'],
	price: ['estimate', 'credit'],
	version: ['vary', 'variation'],
	variation: ['vary'],
	illustration: ['vector', 'art'],
	svg: ['vector'],
	space: ['gap'],
	empty: ['gap'],
	blemish: ['heal', 'spot'],
	tonal: ['histogram'],
	tone: ['histogram', 'level'],
	um: ['filler'],
	uh: ['filler'],
	dissolve: ['transition'],
	crossfade: ['transition'],
	wipe: ['transition'],
	mark: ['marker'],
	timelapse: ['time', 'lapse'],
	brightness: ['adjustment', 'exposure'],
	brighter: ['adjustment', 'exposure'],
	contrast: ['adjustment'],
	shadow: ['effect'],
	glow: ['effect'],
	grain: ['effect', 'paper'],
	look: ['grade', 'preset'],
	cinematic: ['grade', 'lut'],
	save: ['export'],
	find: ['search'],
	search: ['find'],
	change: ['update', 'set', 'edit'],
	menu: ['command'],
	action: ['command'],
	shortcut: ['command']
};

/** Lower-cased, stemmed word tokens of `text`, splitting snake_case and camelCase. */
export function searchTokens(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w))
		.map((w) => {
			const stemmed = stem(w);
			return SPELLING[stemmed] ?? stemmed;
		});
}

/** The first sentence of a description, for compact listings. */
export function summarize(description: string | undefined, max = 200): string {
	if (!description) return '';
	const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(description.trim());
	const sentence = (match ? match[0] : description.trim()).replace(/\s+/g, ' ');
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

// Verbs nearly every editor has a tool for: weak evidence of which tool is meant, so they
// count no more in a tool's name or title than in its description.
const COMMON_VERBS = new Set(['add', 'set', 'get', 'remove', 'list', 'update', 'change', 'make', 'create', 'delete', 'read', 'show', 'put', 'use', 'edit']);

// Field weights: a word in the tool's own name is the strongest signal.
const WEIGHTS = { name: 4, title: 2.5, toolset: 1.5, description: 1, params: 0.5 } as const;

interface Doc {
	tool: McpToolDefinition;
	toolset: ToolsetInfo;
	fields: Record<keyof typeof WEIGHTS, Set<string>>;
}

// Token sets by text. Listings rebuild tool definitions (and some schemas) on every call but
// the text rarely changes, so keying by content keeps the index across searches and still
// picks up a changed title, description or toolset. Cleared when it outgrows any catalogue.
const tokenCache = new Map<string, Set<string>>();
const TOKEN_CACHE_LIMIT = 20_000;

function tokenSet(text: string): Set<string> {
	let tokens = tokenCache.get(text);
	if (!tokens) {
		if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
		tokens = new Set(searchTokens(text));
		tokenCache.set(text, tokens);
	}
	return tokens;
}

/** Argument names, descriptions and enum values, one level deep (e.g. a transition's types). */
function paramText(schema: unknown, depth = 0): string {
	if (!schema || typeof schema !== 'object' || depth > 2) return '';
	const s = schema as { properties?: Record<string, unknown>; description?: unknown; enum?: unknown; items?: unknown; anyOf?: unknown };
	const parts: string[] = [];
	if (typeof s.description === 'string' && depth > 0) parts.push(s.description);
	if (Array.isArray(s.enum)) parts.push(s.enum.filter((v) => typeof v === 'string').join(' '));
	for (const [key, value] of Object.entries(s.properties ?? {})) parts.push(key, paramText(value, depth + 1));
	if (s.items) parts.push(paramText(s.items, depth + 1));
	if (Array.isArray(s.anyOf)) for (const branch of s.anyOf) parts.push(paramText(branch, depth + 1));
	return parts.join(' ');
}

// Argument text by schema object: most providers hand out the same schema on every listing.
const schemaTextCache = new WeakMap<object, string>();

function schemaText(schema: McpToolDefinition['inputSchema']): string {
	let text = schemaTextCache.get(schema);
	if (text === undefined) {
		text = paramText(schema);
		schemaTextCache.set(schema, text);
	}
	return text;
}

function document(tool: McpToolDefinition, toolset: ToolsetInfo, toolsetTokens: Set<string>): Doc {
	const fields = {
		name: tokenSet(baseToolName(tool.name)),
		title: tokenSet(tool.title ?? tool.annotations?.title ?? ''),
		toolset: toolsetTokens,
		description: tokenSet(tool.description ?? ''),
		params: tokenSet(schemaText(tool.inputSchema))
	};
	return { tool, toolset, fields };
}

/**
 * How well `word` matches a field's tokens, as the rarity (idf) of what matched: the word
 * itself in full, or at half value a longer word it starts ("trend" → "trendline") or a synonym.
 */
function matchValue(tokens: Set<string>, word: string, alternatives: readonly string[], idf: Map<string, number>): number {
	const rarity = idf.get(word) ?? 1;
	if (tokens.has(word)) return rarity;
	let value = 0;
	if (word.length >= 4) {
		for (const t of tokens) {
			if (t.startsWith(word) || (t.length >= 4 && word.startsWith(t))) {
				value = rarity / 2;
				break;
			}
		}
	}
	for (const alt of alternatives) {
		// A synonym is worth no more than the word itself would be.
		if (tokens.has(alt)) value = Math.max(value, Math.min(rarity, idf.get(alt) ?? 1) / 2);
	}
	return value;
}

/**
 * Ranks tools against a free-text query: every query word scores by the
 * fields it appears in (name, title, toolset, description, arguments), weighted by how
 * rare the word is across all tools, so "trendline" outranks "chart". A word
 * that prefixes a longer one ("trend" → "trendline") counts at half weight.
 * Pure and dependency-free; `search_tools` uses it.
 */
export function searchTools(
	tools: readonly McpToolDefinition[],
	toolsets: readonly ToolsetInfo[],
	query: string,
	options: ToolSearchOptions = {}
): ToolSearchResult[] {
	const setOf = new Map<string, ToolsetInfo>();
	for (const set of toolsets) for (const name of set.tools) setOf.set(name, set);
	const setTokens = new Map<ToolsetInfo, Set<string>>();
	const all = tools.map((tool) => {
		const set = setOf.get(tool.name) ?? { name: '', providers: [], tools: [tool.name] };
		let tokens = setTokens.get(set);
		if (!tokens) {
			tokens = tokenSet(`${set.name} ${set.title ?? ''} ${set.description ?? ''}`);
			setTokens.set(set, tokens);
		}
		return document(tool, set, tokens);
	});
	const docs = options.toolset ? all.filter((d) => d.toolset.name === options.toolset) : all;
	const words = Array.from(new Set(searchTokens(query)));
	if (words.length === 0 || docs.length === 0) return [];
	const alternatives = new Map(words.map((w) => [w, (SYNONYMS[w] ?? []).map(stem)]));

	// Document frequency over the whole catalogue, so a toolset filter doesn't distort rarity.
	const fieldNames = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];
	const idf = new Map<string, number>();
	for (const word of [...words, ...[...alternatives.values()].flat()]) {
		if (idf.has(word)) continue;
		const df = all.filter((d) => fieldNames.some((field) => d.fields[field].has(word))).length;
		idf.set(word, Math.log(1 + all.length / (1 + df)));
	}

	const phrase = query.trim().toLowerCase().replace(/\s+/g, '_');
	const results: ToolSearchResult[] = [];
	for (const doc of docs) {
		let score = 0;
		let matched = 0;
		for (const word of words) {
			// The best field for this word: its weight times the rarity of the term that matched.
			let best = 0;
			for (const field of fieldNames) {
				const weight = COMMON_VERBS.has(word) ? Math.min(WEIGHTS[field], WEIGHTS.description) : WEIGHTS[field];
				const value = matchValue(doc.fields[field], word, alternatives.get(word) ?? [], idf) * weight;
				best = Math.max(best, value);
				score += value * 0.1;
			}
			if (best > 0) matched++;
			score += best;
		}
		if (matched === 0) continue;
		// Favour tools that match more of the query, and exact names.
		score *= 0.5 + (0.5 * matched) / words.length;
		const base = baseToolName(doc.tool.name);
		if (base === phrase || doc.tool.name === phrase) score *= 3;
		results.push({
			name: doc.tool.name,
			toolset: doc.toolset.name,
			...(doc.tool.title ? { title: doc.tool.title } : {}),
			summary: summarize(doc.tool.description),
			readOnly: doc.tool.annotations?.readOnlyHint === true,
			score: Math.round(score * 100) / 100
		});
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, options.limit ?? 10);
}
