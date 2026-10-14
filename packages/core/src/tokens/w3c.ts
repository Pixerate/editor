// Portions ported from figcraft/crates/engine/src/variables_io_tests.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { hexToRgba, normalizeTokenColor } from './color.js';
import {
	addTokenMode,
	checkTokenAlias,
	coerceTokenLiteral,
	createTokenCollection,
	createTokenVariable,
	defaultTokenId,
	findTokenCollection,
	findTokenMode,
	findTokenVariable,
	getTokenCollection,
	getTokenVariable,
	normalizeTokenName,
	setTokenValue,
	updateTokenVariable,
	type TokenIdFactory
} from './model.js';
import {
	TokenError,
	isTokenAlias,
	type TokenCollection,
	type TokenLiteral,
	type TokenModeContext,
	type TokenState,
	type TokenType,
	type TokenValue,
	type TokenVariable
} from './types.js';

/**
 * W3C Design Tokens (DTCG) JSON. Each collection is a top-level group named after it; variable
 * names' `/` groups become nested groups; aliases are `{Collection.group.token}` references.
 * `$value` holds the default mode (or the modes passed in). Modes, ids and scopes ride along in
 * `$extensions["com.pixerate.tokens"]`, so an export round-trips; tools that ignore extensions
 * still read the default mode. Strings and booleans use `$type: "string"` / `"boolean"`
 * (outside the spec, as Tokens Studio and Style Dictionary do).
 */
export const W3C_TOKENS_EXTENSION = 'com.pixerate.tokens';

export interface W3CTokensExportOptions {
	/** Collections to export (ids; default all). */
	collections?: readonly string[];
	/** Modes that supply `$value` (default: each collection's default mode). */
	modes?: TokenModeContext;
	/** Include `$extensions` with ids, every mode's value and scopes (default `true`). */
	extensions?: boolean;
	/** Colours as `#hex` strings (default) or W3C colour objects. */
	colorFormat?: 'hex' | 'object';
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function path(name: string): string[] {
	return name.split('/');
}

function reference(state: TokenState, variable: TokenVariable): string {
	const collection = getTokenCollection(state, variable.collectionId);
	return `{${[collection?.name ?? variable.collectionId, ...path(variable.name)].join('.')}}`;
}

function w3cType(variable: TokenVariable): string {
	if (variable.type === 'number') {
		if (variable.unit === 'ms' || variable.unit === 's') return 'duration';
		if (variable.unit) return 'dimension';
	}
	return variable.type;
}

function w3cLiteral(variable: TokenVariable, value: TokenLiteral, colorFormat: 'hex' | 'object'): Json {
	if (variable.type === 'color' && colorFormat === 'object') {
		const c = hexToRgba(String(value));
		if (c) {
			const round = (n: number) => Math.round(n * 10000) / 10000;
			return { colorSpace: 'srgb', components: [round(c.r), round(c.g), round(c.b)], alpha: round(c.a), hex: String(value).slice(0, 7) };
		}
	}
	if (variable.type === 'number' && variable.unit) return { value: value as number, unit: variable.unit };
	return value;
}

function w3cValue(state: TokenState, variable: TokenVariable, value: TokenValue | undefined, colorFormat: 'hex' | 'object'): Json {
	if (value === undefined) return null;
	if (isTokenAlias(value)) {
		const target = getTokenVariable(state, value.alias);
		return target ? reference(state, target) : null;
	}
	return w3cLiteral(variable, value, colorFormat);
}

/** The tokens as a W3C Design Tokens object (see {@link W3C_TOKENS_EXTENSION}). */
export function exportW3CTokens(state: TokenState, options: W3CTokensExportOptions = {}): Record<string, Json> {
	const withExtensions = options.extensions !== false;
	const colorFormat = options.colorFormat ?? 'hex';
	const wanted = options.collections ? new Set(options.collections) : null;
	const root: Record<string, Json> = {};
	for (const collection of state.collections) {
		if (wanted && !wanted.has(collection.id)) continue;
		const group: Record<string, Json> = {};
		if (withExtensions) {
			group.$extensions = {
				[W3C_TOKENS_EXTENSION]: { id: collection.id, modes: collection.modes.map((m) => ({ id: m.id, name: m.name })) }
			};
		}
		const chosen = options.modes?.[collection.id];
		const mode = (chosen !== undefined && collection.modes.find((m) => m.id === chosen)) || collection.modes[0];
		for (const variable of state.variables) {
			if (variable.collectionId !== collection.id) continue;
			const token: Record<string, Json> = {
				$type: w3cType(variable),
				$value: w3cValue(state, variable, variable.valuesByMode[mode.id], colorFormat)
			};
			if (variable.description) token.$description = variable.description;
			if (withExtensions) {
				const modes: Record<string, Json> = {};
				for (const m of collection.modes) modes[m.name] = w3cValue(state, variable, variable.valuesByMode[m.id], colorFormat);
				const ext: Record<string, Json> = { id: variable.id, modes };
				if (variable.scopes) ext.scopes = [...variable.scopes];
				if (variable.unit) ext.unit = variable.unit;
				token.$extensions = { [W3C_TOKENS_EXTENSION]: ext };
			}
			let at = group;
			const segments = path(variable.name);
			for (const segment of segments.slice(0, -1)) {
				const next = at[segment];
				if (typeof next !== 'object' || next === null || Array.isArray(next) || '$value' in next) at[segment] = {};
				at = at[segment] as Record<string, Json>;
			}
			at[segments[segments.length - 1]] = token;
		}
		root[collection.name] = group;
	}
	return root;
}

/** {@link exportW3CTokens} as indented JSON text. */
export function exportW3CTokensJson(state: TokenState, options: W3CTokensExportOptions = {}): string {
	return JSON.stringify(exportW3CTokens(state, options), null, 2);
}

// ---------------------------------------------------------------------------------------------
// Import

export interface W3CTokensImportOptions {
	/**
	 * Collection for tokens outside a marked collection group (a plain W3C file). Default
	 * `"Tokens"`; an existing collection with that name is updated.
	 */
	collection?: string;
	/** Mode that plain `$value`s go to (name; created when missing). Default: the default mode. */
	mode?: string;
	createId?: TokenIdFactory;
}

export interface W3CTokensImportReport {
	collectionsAdded: number;
	modesAdded: number;
	variablesAdded: number;
	/** Existing variables (matched by collection and name) that were updated in place. */
	variablesUpdated: number;
	/** Entries skipped or values not taken, with the reason. */
	warnings: string[];
}

interface RawToken {
	collection: string;
	path: string[];
	type: string | undefined;
	value: unknown;
	description: unknown;
	ext: Record<string, unknown> | undefined;
}

const MAX_DEPTH = 32;
const REF = /^\{([^{}]+)\}$/;
const MEASURE = /^(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i;
const FONT_WEIGHTS: Record<string, number> = {
	thin: 100,
	hairline: 100,
	'extra-light': 200,
	'ultra-light': 200,
	light: 300,
	normal: 400,
	regular: 400,
	book: 400,
	medium: 500,
	'semi-bold': 600,
	'demi-bold': 600,
	bold: 700,
	'extra-bold': 800,
	'ultra-bold': 800,
	black: 900,
	heavy: 900,
	'extra-black': 950,
	'ultra-black': 950
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function extensionOf(node: Record<string, unknown>): Record<string, unknown> | undefined {
	const ext = node.$extensions;
	if (!isObject(ext)) return undefined;
	const ours = ext[W3C_TOKENS_EXTENSION];
	return isObject(ours) ? ours : undefined;
}

function aliasRef(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 1000) return null;
	const match = REF.exec(value.trim());
	return match ? match[1].trim() : null;
}

/** W3C type → our type, or `null` for types we don't take (composites). */
function mapType(type: string): TokenType | null {
	switch (type) {
		case 'color':
			return 'color';
		case 'number':
		case 'dimension':
		case 'duration':
		case 'fontWeight':
			return 'number';
		case 'string':
		case 'text':
		case 'fontFamily':
		case 'fontStyle':
			return 'string';
		case 'boolean':
			return 'boolean';
		default:
			return null;
	}
}

function inferType(value: unknown): string | undefined {
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return 'number';
	if (typeof value === 'string') {
		const text = value.trim();
		if ((text.startsWith('#') || /^rgba?\(/i.test(text)) && normalizeTokenColor(text)) return 'color';
		if (MEASURE.test(text) && /[a-z%]$/i.test(text)) return 'dimension';
		return 'string';
	}
	if (isObject(value) && Array.isArray(value.components)) return 'color';
	if (isObject(value) && typeof value.value === 'number' && typeof value.unit === 'string') return 'dimension';
	return undefined;
}

/** A literal and (for numbers) unit from a W3C value of `w3cType`, or `null`. */
function readLiteral(w3cType: string, type: TokenType, value: unknown): { value: TokenLiteral; unit?: string } | null {
	if (type === 'number') {
		if (w3cType === 'fontWeight' && typeof value === 'string') {
			const weight = FONT_WEIGHTS[value.trim().toLowerCase()];
			return weight === undefined ? null : { value: weight };
		}
		if (isObject(value) && typeof value.value === 'number' && Number.isFinite(value.value)) {
			const unit = typeof value.unit === 'string' && /^[a-z%]{1,8}$/i.test(value.unit) ? value.unit.toLowerCase() : undefined;
			return { value: value.value, unit };
		}
		if (typeof value === 'string' && value.length <= 100) {
			const match = MEASURE.exec(value.trim());
			if (!match) return null;
			const n = Number(match[1]);
			if (!Number.isFinite(n)) return null;
			const unit = match[2] ? match[2].toLowerCase() : undefined;
			return { value: n, unit: unit && unit.length <= 8 ? unit : undefined };
		}
		const n = coerceTokenLiteral('number', value);
		return n === null ? null : { value: n };
	}
	if (type === 'string' && w3cType === 'fontFamily' && Array.isArray(value)) {
		return value.every((v) => typeof v === 'string') ? { value: value.join(', ') } : null;
	}
	const literal = coerceTokenLiteral(type, value);
	return literal === null ? null : { value: literal };
}

function collectTokens(
	group: Record<string, unknown>,
	collection: string,
	prefix: string[],
	inheritedType: string | undefined,
	out: RawToken[],
	warnings: string[],
	depth: number
): void {
	if (depth > MAX_DEPTH) {
		warnings.push(`\`${prefix.join('.')}\` is nested too deeply; skipped`);
		return;
	}
	const groupType = typeof group.$type === 'string' ? group.$type : inheritedType;
	for (const [key, child] of Object.entries(group)) {
		if (key.startsWith('$')) continue;
		const at = [...prefix, key];
		if (!isObject(child)) {
			warnings.push(`\`${at.join('.')}\` is not a token or group; skipped`);
			continue;
		}
		if ('$value' in child) {
			out.push({
				collection,
				path: at,
				type: typeof child.$type === 'string' ? child.$type : groupType,
				value: child.$value,
				description: child.$description,
				ext: extensionOf(child)
			});
		} else collectTokens(child, collection, at, groupType, out, warnings, depth + 1);
	}
}

/**
 * Merges a W3C Design Tokens document (object or JSON text) into `state`. Collections, modes
 * and variables are matched by name and updated in place (ids, and so canvas bindings, are
 * kept); new ones take the ids in the file's extensions when free. Junk entries, type clashes,
 * unresolved references and alias cycles are skipped with a warning. Throws `invalid-input`
 * only when the input is not a JSON object.
 */
export function importW3CTokens(
	state: TokenState,
	input: unknown,
	options: W3CTokensImportOptions = {}
): { state: TokenState; report: W3CTokensImportReport } {
	let doc = input;
	if (typeof doc === 'string') {
		try {
			doc = JSON.parse(doc);
		} catch {
			throw new TokenError('invalid-input', 'Not JSON');
		}
	}
	if (!isObject(doc)) throw new TokenError('invalid-input', 'Expected a design tokens object');
	const createId = options.createId ?? defaultTokenId;
	const report: W3CTokensImportReport = { collectionsAdded: 0, modesAdded: 0, variablesAdded: 0, variablesUpdated: 0, warnings: [] };
	const warn = (message: string) => {
		if (report.warnings.length < 500) report.warnings.push(message);
	};

	// Which top-level groups are collections.
	const marked = Object.entries(doc).filter(([key, value]) => !key.startsWith('$') && isObject(value) && !('$value' in value) && Array.isArray(extensionOf(value)?.modes));
	const plainName = options.collection ?? 'Tokens';
	const sources: { name: string; group: Record<string, unknown>; modes?: unknown[]; id?: unknown; plain: boolean }[] = [];
	if (marked.length > 0) {
		for (const [key, value] of marked) {
			const ext = extensionOf(value as Record<string, unknown>)!;
			sources.push({ name: key, group: value as Record<string, unknown>, modes: ext.modes as unknown[], id: ext.id, plain: false });
		}
		const rest: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(doc)) if (!marked.some(([k]) => k === key)) rest[key] = value;
		if (Object.keys(rest).some((k) => !k.startsWith('$'))) sources.push({ name: plainName, group: rest, plain: true });
	} else sources.push({ name: plainName, group: doc, plain: true });

	const usedIds = new Set<string>([...state.collections.map((c) => c.id), ...state.variables.map((v) => v.id)]);
	for (const c of state.collections) for (const m of c.modes) usedIds.add(m.id);
	const idFrom = (candidate: unknown, kind: 'collection' | 'mode' | 'variable'): TokenIdFactory => (k) => {
		if (k === kind && typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200 && !usedIds.has(candidate)) {
			usedIds.add(candidate);
			return candidate;
		}
		const id = createId(k);
		usedIds.add(id);
		return id;
	};

	let next = state;
	const tokens: RawToken[] = [];
	const collectionIds = new Map<string, string>();
	const plainMode = new Map<string, string>();

	const ensureMode = (collectionId: string, name: string, id?: unknown): string | null => {
		const collection = getTokenCollection(next, collectionId)!;
		const existing = findTokenMode(collection, name);
		if (existing) return existing.id;
		try {
			const result = addTokenMode(next, collectionId, name, {}, idFrom(id, 'mode'));
			next = result.state;
			report.modesAdded += 1;
			return result.mode.id;
		} catch (error) {
			warn(`Mode \`${name}\`: ${(error as Error).message}`);
			return null;
		}
	};

	for (const source of sources) {
		let collection: TokenCollection | undefined = findTokenCollection(next, source.name);
		if (!collection) {
			const declared = (source.modes ?? []).filter(isObject);
			const names = declared.map((m) => m.name).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
			if (source.plain && options.mode) names.splice(0, names.length, options.mode);
			try {
				const ids = [source.id, ...declared.map((m) => m.id)];
				let i = 0;
				const factory: TokenIdFactory = (kind) => idFrom(kind === 'collection' ? ids[0] : ids[++i], kind)(kind);
				const result = createTokenCollection(next, { name: source.name, modes: names.length ? names : undefined }, factory);
				next = result.state;
				collection = result.collection;
				report.collectionsAdded += 1;
			} catch (error) {
				warn(`Collection \`${source.name}\`: ${(error as Error).message}`);
				continue;
			}
		} else {
			for (const m of (source.modes ?? []).filter(isObject)) {
				if (typeof m.name === 'string' && m.name.trim()) ensureMode(collection.id, m.name, m.id);
			}
		}
		collectionIds.set(source.name, collection.id);
		const modeId = options.mode && source.plain ? ensureMode(collection.id, options.mode) : getTokenCollection(next, collection.id)!.modes[0].id;
		if (modeId) plainMode.set(source.name, modeId);
		collectTokens(source.group, source.name, [], undefined, tokens, report.warnings, 0);
	}

	// Paths for references: `Collection.a.b` and (within a collection) `a.b`.
	const byFullPath = new Map<string, RawToken>();
	for (const token of tokens) byFullPath.set([token.collection, ...token.path].join('.'), token);
	const findRaw = (ref: string, from: RawToken): RawToken | undefined =>
		byFullPath.get(ref) ?? byFullPath.get(`${from.collection}.${ref}`);

	// Types of untyped aliases follow their targets.
	const typeOf = (token: RawToken): string | undefined => {
		let current: RawToken | undefined = token;
		for (let i = 0; i < MAX_DEPTH && current; i++) {
			if (current.type) return current.type;
			const ref = aliasRef(current.value);
			if (ref === null) return inferType(current.value);
			current = findRaw(ref, current);
		}
		return undefined;
	};

	const pending: { variable: TokenVariable; modeId: string; ref: string; token: RawToken }[] = [];
	const variableFor = new Map<RawToken, string>();
	for (const token of tokens) {
		const label = [token.collection, ...token.path].join('.');
		const collectionId = collectionIds.get(token.collection);
		if (!collectionId) continue;
		const w3cType = typeOf(token);
		const type = w3cType ? mapType(w3cType) : null;
		if (!w3cType || !type) {
			warn(`\`${label}\` has an unsupported type \`${w3cType ?? 'unknown'}\`; skipped`);
			continue;
		}
		let name: string;
		try {
			name = normalizeTokenName(token.path.join('/'));
		} catch (error) {
			warn(`\`${label}\`: ${(error as Error).message}`);
			continue;
		}
		let variable = findTokenVariable(next, name, collectionId);
		if (variable && variable.type !== type) {
			warn(`\`${name}\` is a ${variable.type} variable; the ${type} token \`${label}\` was skipped`);
			continue;
		}
		if (!variable) {
			try {
				const result = createTokenVariable(next, { collectionId, name, type }, idFrom(token.ext?.id, 'variable'));
				next = result.state;
				variable = result.variable;
				report.variablesAdded += 1;
			} catch (error) {
				warn(`\`${label}\`: ${(error as Error).message}`);
				continue;
			}
		} else report.variablesUpdated += 1;
		variableFor.set(token, variable.id);

		// Values: per mode from our extension, else `$value` into the plain mode.
		const values: [string, unknown][] = [];
		const extModes = token.ext?.modes;
		if (isObject(extModes)) {
			for (const [modeName, value] of Object.entries(extModes)) {
				const modeId = ensureMode(collectionId, modeName);
				if (modeId) values.push([modeId, value]);
			}
		} else {
			const modeId = plainMode.get(token.collection);
			if (modeId) values.push([modeId, token.value]);
		}
		let unit: string | undefined;
		for (const [modeId, raw] of values) {
			const ref = aliasRef(raw);
			if (ref !== null) {
				pending.push({ variable, modeId, ref, token });
				continue;
			}
			const literal = readLiteral(w3cType, type, raw);
			if (!literal) {
				warn(`\`${label}\` has an invalid ${w3cType} value; kept the previous value`);
				continue;
			}
			if (literal.unit) unit = literal.unit;
			next = setTokenValue(next, variable.id, literal.value, modeId);
		}
		const update: { description?: string; scopes?: string[]; unit?: string } = {};
		if (typeof token.description === 'string') update.description = token.description;
		const extUnit = token.ext?.unit;
		if (typeof extUnit === 'string') unit = extUnit;
		if (unit && unit !== variable.unit) update.unit = unit;
		if (Array.isArray(token.ext?.scopes)) update.scopes = (token.ext!.scopes as unknown[]).filter((s): s is string => typeof s === 'string');
		if (Object.keys(update).length > 0) {
			try {
				next = updateTokenVariable(next, variable.id, update);
			} catch (error) {
				warn(`\`${label}\`: ${(error as Error).message}`);
			}
		}
	}

	// Aliases, once every variable exists.
	for (const { variable, modeId, ref, token } of pending) {
		const label = [token.collection, ...token.path].join('.');
		const raw = findRaw(ref, token);
		let targetId = raw ? variableFor.get(raw) : undefined;
		if (!targetId) {
			// A variable already in the state: `Collection.a.b` or `a.b` in this collection.
			const dot = ref.indexOf('.');
			const inCollection = dot > 0 ? findTokenCollection(next, ref.slice(0, dot)) : undefined;
			const found =
				(inCollection && findTokenVariable(next, ref.slice(dot + 1).split('.').join('/'), inCollection.id)) ||
				findTokenVariable(next, ref.split('.').join('/'), variable.collectionId);
			targetId = found ? found.id : undefined;
		}
		if (!targetId) {
			warn(`\`${label}\` refers to \`{${ref}}\`, which doesn't exist; kept the previous value`);
			continue;
		}
		const current = getTokenVariable(next, variable.id)!;
		const error = checkTokenAlias(next, current, targetId);
		if (error) {
			warn(`\`${label}\`: ${error.message}`);
			continue;
		}
		next = setTokenValue(next, variable.id, { alias: targetId }, modeId);
	}

	return { state: next, report };
}
