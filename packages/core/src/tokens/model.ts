// Portions ported from figcraft/crates/doc/src/styles.rs and figcraft/crates/engine/src/cmd/variables.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { normalizeTokenColor } from './color.js';
import {
	TokenError,
	isTokenAlias,
	type TokenCollection,
	type TokenLiteral,
	type TokenMode,
	type TokenModeContext,
	type TokenScope,
	type TokenState,
	type TokenType,
	type TokenValue,
	type TokenVariable
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Lookups

interface TokenIndex {
	collections: Map<string, TokenCollection>;
	variables: Map<string, TokenVariable>;
}

const indexes = new WeakMap<TokenState, TokenIndex>();

function indexOf(state: TokenState): TokenIndex {
	let index = indexes.get(state);
	if (!index) {
		index = {
			collections: new Map(state.collections.map((c) => [c.id, c])),
			variables: new Map(state.variables.map((v) => [v.id, v]))
		};
		indexes.set(state, index);
	}
	return index;
}

export function getTokenCollection(state: TokenState, id: string): TokenCollection | undefined {
	return indexOf(state).collections.get(id);
}

export function getTokenVariable(state: TokenState, id: string): TokenVariable | undefined {
	return indexOf(state).variables.get(id);
}

/** The collection with this name. */
export function findTokenCollection(state: TokenState, name: string): TokenCollection | undefined {
	return state.collections.find((c) => c.name === name);
}

/** The variable named `name` (in `collectionId` when given, else the first match). */
export function findTokenVariable(state: TokenState, name: string, collectionId?: string): TokenVariable | undefined {
	return state.variables.find((v) => v.name === name && (collectionId === undefined || v.collectionId === collectionId));
}

/** The variables of a collection, in order. */
export function getCollectionVariables(state: TokenState, collectionId: string): TokenVariable[] {
	return state.variables.filter((v) => v.collectionId === collectionId);
}

/** The collection's default (first) mode. */
export function getDefaultMode(collection: TokenCollection): TokenMode {
	return collection.modes[0];
}

/** The mode with id `key`, else the one named `key`. */
export function findTokenMode(collection: TokenCollection, key: string): TokenMode | undefined {
	return collection.modes.find((m) => m.id === key) ?? collection.modes.find((m) => m.name === key);
}

/** The mode `collection` is in under `modes` (its chosen mode if valid, else the default). */
export function getCurrentMode(collection: TokenCollection, modes: TokenModeContext | undefined): TokenMode {
	const chosen = modes?.[collection.id];
	return (chosen !== undefined && collection.modes.find((m) => m.id === chosen)) || collection.modes[0];
}

// ---------------------------------------------------------------------------------------------
// Values

/** A new variable's value per type: black, 0, empty, true (figcraft's pinned defaults). */
export function defaultTokenValue(type: TokenType): TokenLiteral {
	switch (type) {
		case 'color':
			return '#000000';
		case 'number':
			return 0;
		case 'string':
			return '';
		case 'boolean':
			return true;
	}
}

/** The literal as `type`, or `null` when it does not fit (colours are normalised). */
export function coerceTokenLiteral(type: TokenType, value: unknown): TokenLiteral | null {
	switch (type) {
		case 'color':
			return normalizeTokenColor(value);
		case 'number': {
			if (typeof value === 'number') return Number.isFinite(value) ? value : null;
			if (typeof value === 'string' && value.trim() !== '') {
				const n = Number(value);
				return Number.isFinite(n) ? n : null;
			}
			return null;
		}
		case 'string':
			return typeof value === 'string' ? value : null;
		case 'boolean':
			if (typeof value === 'boolean') return value;
			if (value === 'true') return true;
			if (value === 'false') return false;
			return null;
	}
}

/** The type of a literal value (strings that are colours count as strings). */
export function literalTokenType(value: TokenLiteral): TokenType {
	return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
}

/** A short text for a value: hex, number, string, boolean, or `→ name` for an alias. */
export function formatTokenValue(state: TokenState, value: TokenValue | undefined): string {
	if (value === undefined) return '';
	if (isTokenAlias(value)) return `→ ${getTokenVariable(state, value.alias)?.name ?? value.alias}`;
	return String(value);
}

// ---------------------------------------------------------------------------------------------
// Resolution

export type TokenResolutionErrorCode = 'missing' | 'cycle' | 'no-value' | 'type-mismatch';

export type TokenResolution =
	| {
			ok: true;
			value: TokenLiteral;
			type: TokenType;
			/** The variable whose literal was used (the end of the alias chain). */
			variable: TokenVariable;
			/** Mode of `variable`'s collection that supplied the value. */
			modeId: string;
			/** Variable ids visited, starting with the requested one. */
			chain: string[];
	  }
	| {
			ok: false;
			code: TokenResolutionErrorCode;
			message: string;
			chain: string[];
	  };

/** The name of a variable for messages. */
function label(state: TokenState, id: string): string {
	const v = getTokenVariable(state, id);
	return v ? `\`${v.name}\`` : `\`${id}\``;
}

/**
 * Resolves variable `id` under `modes` (collection id → mode id; the default mode otherwise),
 * following aliases. Each variable along the chain is read in its own collection's mode.
 * Cycles, missing variables and type changes along the chain are reported, never thrown.
 */
export function resolveToken(state: TokenState, id: string, modes?: TokenModeContext): TokenResolution {
	const chain: string[] = [];
	const seen = new Set<string>();
	let current = id;
	let type: TokenType | undefined;
	for (;;) {
		if (seen.has(current)) {
			chain.push(current);
			return {
				ok: false,
				code: 'cycle',
				message: `Alias cycle: ${chain.map((c) => label(state, c)).join(' → ')}`,
				chain
			};
		}
		seen.add(current);
		chain.push(current);
		const variable = getTokenVariable(state, current);
		if (!variable) {
			return {
				ok: false,
				code: 'missing',
				message:
					chain.length === 1
						? `No variable ${label(state, current)}`
						: `${label(state, chain[chain.length - 2])} aliases a missing variable ${label(state, current)}`,
				chain
			};
		}
		if (type !== undefined && variable.type !== type) {
			return {
				ok: false,
				code: 'type-mismatch',
				message: `${label(state, chain[chain.length - 2])} (${type}) aliases ${label(state, current)} (${variable.type})`,
				chain
			};
		}
		type = variable.type;
		const collection = getTokenCollection(state, variable.collectionId);
		const mode = collection ? getCurrentMode(collection, modes) : undefined;
		let modeId = mode?.id;
		let value = modeId !== undefined ? variable.valuesByMode[modeId] : undefined;
		if (value === undefined) {
			// figcraft: a missing per-mode value falls back to the default mode, then any value.
			const fallback = collection?.modes[0]?.id;
			if (fallback !== undefined && variable.valuesByMode[fallback] !== undefined) {
				modeId = fallback;
				value = variable.valuesByMode[fallback];
			} else {
				const first = Object.keys(variable.valuesByMode)[0];
				if (first !== undefined) {
					modeId = first;
					value = variable.valuesByMode[first];
				}
			}
		}
		if (value === undefined || modeId === undefined) {
			return { ok: false, code: 'no-value', message: `${label(state, current)} has no value`, chain };
		}
		if (isTokenAlias(value)) {
			current = value.alias;
			continue;
		}
		return { ok: true, value, type: variable.type, variable, modeId, chain };
	}
}

/** The resolved literal, or `undefined` when it does not resolve. */
export function resolveTokenValue(state: TokenState, id: string, modes?: TokenModeContext): TokenLiteral | undefined {
	const result = resolveToken(state, id, modes);
	return result.ok ? result.value : undefined;
}

/** The value of `variableId` in mode `modeId` of its own collection (other collections in their default mode). */
export function resolveTokenInMode(state: TokenState, variableId: string, modeId: string): TokenLiteral | undefined {
	const variable = getTokenVariable(state, variableId);
	if (!variable) return undefined;
	return resolveTokenValue(state, variableId, { [variable.collectionId]: modeId });
}

/**
 * Why `variable` cannot alias `targetId`, or `null` when it can: the target must exist, have
 * the same type, and not lead back to `variable` through any alias in any mode.
 */
export function checkTokenAlias(state: TokenState, variable: Pick<TokenVariable, 'id' | 'type' | 'name'>, targetId: string): TokenError | null {
	const target = getTokenVariable(state, targetId);
	if (!target) return new TokenError('alias-missing', `No variable \`${targetId}\` to alias`);
	if (target.type !== variable.type) {
		return new TokenError('type-mismatch', `Can't alias a ${variable.type} variable to a ${target.type} one (\`${target.name}\`)`);
	}
	// Depth-first search over alias edges in every mode, remembering the path for the message.
	const parent = new Map<string, string | null>([[target.id, null]]);
	const stack = [target.id];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === variable.id) {
			const path: string[] = [];
			for (let at: string | null | undefined = current; at != null; at = parent.get(at)) path.push(at);
			const names = [variable.id, ...path.reverse()].map((id) => (id === variable.id ? `\`${variable.name}\`` : label(state, id)));
			return new TokenError('alias-cycle', `The alias would create a cycle: ${names.join(' → ')}`);
		}
		const v = getTokenVariable(state, current);
		if (!v) continue;
		for (const value of Object.values(v.valuesByMode)) {
			if (isTokenAlias(value) && !parent.has(value.alias)) {
				parent.set(value.alias, current);
				stack.push(value.alias);
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Scopes

export const TOKEN_SCOPES_BY_TYPE: Readonly<Record<TokenType, readonly TokenScope[]>> = {
	number: [
		'CORNER_RADIUS',
		'WIDTH_HEIGHT',
		'GAP',
		'OPACITY',
		'STROKE_FLOAT',
		'EFFECT_FLOAT',
		'FONT_WEIGHT',
		'FONT_SIZE',
		'LINE_HEIGHT',
		'LETTER_SPACING',
		'PARAGRAPH_SPACING',
		'PARAGRAPH_INDENT',
		'TEXT_CONTENT'
	],
	color: ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR'],
	string: ['TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE'],
	boolean: []
};

/** Whether `scope` is a scope a variable of `type` can be limited to. */
export function isTokenScopeKnown(type: TokenType, scope: string): scope is TokenScope {
	return scope === 'ALL_SCOPES' || (scope === 'ALL_FILLS' && type === 'color') || (TOKEN_SCOPES_BY_TYPE[type] as readonly string[]).includes(scope);
}

/**
 * Canonical scope list: known ids only, no repeats, `undefined` (no limit) when every
 * supported property is named. Unknown ids throw `unknown-scope`.
 */
export function normalizeTokenScopes(type: TokenType, scopes: readonly string[] | null | undefined): TokenScope[] | undefined {
	if (scopes == null) return undefined;
	const list: TokenScope[] = [];
	for (const scope of scopes) {
		if (!isTokenScopeKnown(type, scope)) throw new TokenError('unknown-scope', `Unknown ${type} scope \`${scope}\``);
		if (!list.includes(scope)) list.push(scope);
	}
	const allowed = TOKEN_SCOPES_BY_TYPE[type];
	const all = list.includes('ALL_SCOPES') || (allowed.length > 0 && allowed.every((s) => list.includes(s)));
	return all ? undefined : list;
}

/** Whether pickers offer `variable` for a property of `scope` (no scope: any). */
export function isTokenInScope(variable: Pick<TokenVariable, 'scopes'>, scope: TokenScope | undefined): boolean {
	if (!variable.scopes || scope === undefined) return true;
	return variable.scopes.some((s) => s === scope || s === 'ALL_SCOPES' || (s === 'ALL_FILLS' && scope.endsWith('_FILL')));
}

// ---------------------------------------------------------------------------------------------
// Names

const BAD_NAME_CHARS = /[{}.]/;

/** Trims each `/`-separated group; throws `invalid-name` when empty or not exportable. */
export function normalizeTokenName(name: unknown, what = 'Variable'): string {
	if (typeof name !== 'string') throw new TokenError('invalid-name', `${what} name must be a string`);
	const segments = name.split('/').map((s) => s.trim());
	if (name.length > 500 || segments.some((s) => s === '')) {
		throw new TokenError('invalid-name', `${what} name \`${name}\` has an empty group`);
	}
	for (const segment of segments) {
		if (BAD_NAME_CHARS.test(segment) || segment.startsWith('$')) {
			throw new TokenError('invalid-name', `${what} name \`${name}\` can't contain \`{\`, \`}\` or \`.\`, or start a group with \`$\``);
		}
	}
	return segments.join('/');
}

function normalizeModeName(name: unknown): string {
	if (typeof name !== 'string' || name.trim() === '') throw new TokenError('invalid-name', 'Mode name can\'t be empty');
	return name.trim().slice(0, 200);
}

function checkVariableName(state: TokenState, collectionId: string, name: string, exceptId?: string): void {
	for (const other of state.variables) {
		if (other.collectionId !== collectionId || other.id === exceptId) continue;
		if (other.name === name) throw new TokenError('duplicate-name', `A variable named \`${name}\` already exists in this collection`);
		// A token can't also be a group (W3C design tokens): `color` and `color/bg` clash.
		if (other.name.startsWith(name + '/') || name.startsWith(other.name + '/')) {
			throw new TokenError('name-conflict', `\`${name}\` clashes with \`${other.name}\`: a name can't be both a variable and a group`);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Operations (pure: each returns a new state, or throws a TokenError)

export type TokenIdFactory = (kind: 'collection' | 'mode' | 'variable') => string;

let fallbackCounter = 0;
/** Default id factory: `crypto.randomUUID`, with a counter fallback. */
export const defaultTokenId: TokenIdFactory = (kind) => {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${kind}-${crypto.randomUUID()}`;
	fallbackCounter += 1;
	return `${kind}-${Date.now().toString(36)}-${fallbackCounter}`;
};

function requireCollection(state: TokenState, id: string): TokenCollection {
	const c = getTokenCollection(state, id);
	if (!c) throw new TokenError('not-found', `No collection \`${id}\``);
	return c;
}

function requireVariable(state: TokenState, id: string): TokenVariable {
	const v = getTokenVariable(state, id);
	if (!v) throw new TokenError('not-found', `No variable \`${id}\``);
	return v;
}

function requireMode(collection: TokenCollection, key: string): TokenMode {
	const m = findTokenMode(collection, key);
	if (!m) throw new TokenError('not-found', `No mode \`${key}\` in \`${collection.name}\``);
	return m;
}

function replaceCollection(state: TokenState, next: TokenCollection): TokenState {
	return { ...state, collections: state.collections.map((c) => (c.id === next.id ? next : c)) };
}

function replaceVariable(state: TokenState, next: TokenVariable): TokenState {
	return { ...state, variables: state.variables.map((v) => (v.id === next.id ? next : v)) };
}

export interface CreateTokenCollectionInput {
	name: string;
	/** Mode names (default `['Default']`). */
	modes?: readonly string[];
}

export function createTokenCollection(
	state: TokenState,
	input: CreateTokenCollectionInput,
	createId: TokenIdFactory = defaultTokenId
): { state: TokenState; collection: TokenCollection } {
	const name = normalizeTokenName(input.name, 'Collection');
	if (state.collections.some((c) => c.name === name)) {
		throw new TokenError('duplicate-name', `A collection named \`${name}\` already exists`);
	}
	const modeNames = input.modes && input.modes.length > 0 ? input.modes.map(normalizeModeName) : ['Default'];
	const collection: TokenCollection = {
		id: createId('collection'),
		name,
		modes: modeNames.map((n) => ({ id: createId('mode'), name: n }))
	};
	return { state: { ...state, collections: [...state.collections, collection] }, collection };
}

export function renameTokenCollection(state: TokenState, id: string, name: string): TokenState {
	const collection = requireCollection(state, id);
	const next = normalizeTokenName(name, 'Collection');
	if (state.collections.some((c) => c.id !== id && c.name === next)) {
		throw new TokenError('duplicate-name', `A collection named \`${next}\` already exists`);
	}
	return replaceCollection(state, { ...collection, name: next });
}

/**
 * Deletes variables `ids`. Variables aliasing one of them take its values (per mode: the deleted
 * variable resolved in that mode when it is in the same collection, else in its default mode).
 */
export function deleteTokenVariables(state: TokenState, ids: Iterable<string>): { state: TokenState; deleted: string[] } {
	const gone = new Set<string>();
	for (const id of ids) if (getTokenVariable(state, id)) gone.add(id);
	if (gone.size === 0) return { state, deleted: [] };
	const variables: TokenVariable[] = [];
	for (const v of state.variables) {
		if (gone.has(v.id)) continue;
		let values: Record<string, TokenValue> | null = null;
		for (const [modeId, value] of Object.entries(v.valuesByMode)) {
			if (!isTokenAlias(value) || !gone.has(value.alias)) continue;
			const target = getTokenVariable(state, value.alias)!;
			const resolved = resolveTokenValue(state, target.id, { [target.collectionId]: modeId, [v.collectionId]: modeId });
			values ??= { ...v.valuesByMode };
			values[modeId] = resolved ?? defaultTokenValue(v.type);
		}
		variables.push(values ? { ...v, valuesByMode: values } : v);
	}
	return { state: { ...state, variables }, deleted: [...gone] };
}

/** Deletes a collection and its variables (aliases into it are detached to their values). */
export function deleteTokenCollection(state: TokenState, id: string): { state: TokenState; deleted: string[] } {
	requireCollection(state, id);
	const result = deleteTokenVariables(
		state,
		state.variables.filter((v) => v.collectionId === id).map((v) => v.id)
	);
	return { state: { ...result.state, collections: result.state.collections.filter((c) => c.id !== id) }, deleted: result.deleted };
}

/**
 * Adds a mode. Variables start with the values of mode `from` (default: the default mode).
 */
export function addTokenMode(
	state: TokenState,
	collectionId: string,
	name: string,
	options: { from?: string } = {},
	createId: TokenIdFactory = defaultTokenId
): { state: TokenState; mode: TokenMode } {
	const collection = requireCollection(state, collectionId);
	const modeName = normalizeModeName(name);
	if (collection.modes.some((m) => m.name === modeName)) {
		throw new TokenError('duplicate-name', `\`${collection.name}\` already has a mode named \`${modeName}\``);
	}
	const source = options.from !== undefined ? requireMode(collection, options.from) : collection.modes[0];
	const mode: TokenMode = { id: createId('mode'), name: modeName };
	let next = replaceCollection(state, { ...collection, modes: [...collection.modes, mode] });
	next = {
		...next,
		variables: next.variables.map((v) => {
			if (v.collectionId !== collectionId) return v;
			const value = v.valuesByMode[source.id] ?? defaultTokenValue(v.type);
			return { ...v, valuesByMode: { ...v.valuesByMode, [mode.id]: value } };
		})
	};
	return { state: next, mode };
}

export function renameTokenMode(state: TokenState, collectionId: string, modeId: string, name: string): TokenState {
	const collection = requireCollection(state, collectionId);
	const mode = requireMode(collection, modeId);
	const modeName = normalizeModeName(name);
	if (collection.modes.some((m) => m.id !== mode.id && m.name === modeName)) {
		throw new TokenError('duplicate-name', `\`${collection.name}\` already has a mode named \`${modeName}\``);
	}
	return replaceCollection(state, { ...collection, modes: collection.modes.map((m) => (m.id === mode.id ? { ...m, name: modeName } : m)) });
}

/** Removes a mode and its values; a collection keeps at least one mode. */
export function removeTokenMode(state: TokenState, collectionId: string, modeId: string): TokenState {
	const collection = requireCollection(state, collectionId);
	const mode = requireMode(collection, modeId);
	if (collection.modes.length < 2) throw new TokenError('last-mode', 'A collection keeps at least one mode');
	const next = replaceCollection(state, { ...collection, modes: collection.modes.filter((m) => m.id !== mode.id) });
	return {
		...next,
		variables: next.variables.map((v) => {
			if (v.collectionId !== collectionId || !(mode.id in v.valuesByMode)) return v;
			const values = { ...v.valuesByMode };
			delete values[mode.id];
			return { ...v, valuesByMode: values };
		})
	};
}

/** Moves a mode to index `to` (clamped). Index 0 makes it the default mode. */
export function moveTokenMode(state: TokenState, collectionId: string, modeId: string, to: number): TokenState {
	const collection = requireCollection(state, collectionId);
	const mode = requireMode(collection, modeId);
	const modes = collection.modes.filter((m) => m.id !== mode.id);
	const at = Math.min(Math.max(Number.isFinite(to) ? Math.trunc(to) : 0, 0), modes.length);
	modes.splice(at, 0, mode);
	return replaceCollection(state, { ...collection, modes });
}

export interface CreateTokenVariableInput {
	collectionId: string;
	name: string;
	type: TokenType;
	/** Value for every mode (literal or `{ alias }`). Default: the type's default. */
	value?: unknown;
	/** Values by mode id or name (win over `value`). */
	values?: Readonly<Record<string, unknown>>;
	description?: string;
	scopes?: readonly string[];
	unit?: string;
}

/** A value for `variable`: a normalised literal or a checked alias. Throws when refused. */
export function prepareTokenValue(state: TokenState, variable: Pick<TokenVariable, 'id' | 'type' | 'name'>, value: unknown): TokenValue {
	if (isTokenAlias(value)) {
		const error = checkTokenAlias(state, variable, value.alias);
		if (error) throw error;
		return { alias: value.alias };
	}
	const literal = coerceTokenLiteral(variable.type, value);
	if (literal === null) {
		throw new TokenError('invalid-value', `\`${String(value)}\` is not a ${variable.type} value for \`${variable.name}\``);
	}
	return literal;
}

function normalizeUnit(unit: unknown): string | undefined {
	if (unit === undefined || unit === null || unit === '') return undefined;
	if (typeof unit !== 'string' || !/^[a-z%]{1,8}$/i.test(unit)) throw new TokenError('invalid-value', `Unknown unit \`${String(unit)}\``);
	return unit.toLowerCase();
}

export function createTokenVariable(
	state: TokenState,
	input: CreateTokenVariableInput,
	createId: TokenIdFactory = defaultTokenId
): { state: TokenState; variable: TokenVariable } {
	const collection = requireCollection(state, input.collectionId);
	if (!(['color', 'number', 'string', 'boolean'] as unknown[]).includes(input.type)) {
		throw new TokenError('invalid-type', `Unknown variable type \`${String(input.type)}\``);
	}
	const name = normalizeTokenName(input.name);
	checkVariableName(state, collection.id, name);
	const id = createId('variable');
	const stub = { id, type: input.type, name };
	const base = input.value === undefined ? defaultTokenValue(input.type) : prepareTokenValue(state, stub, input.value);
	const valuesByMode: Record<string, TokenValue> = {};
	for (const mode of collection.modes) valuesByMode[mode.id] = base;
	if (input.values) {
		for (const [key, raw] of Object.entries(input.values)) {
			const mode = requireMode(collection, key);
			valuesByMode[mode.id] = prepareTokenValue(state, stub, raw);
		}
	}
	const variable: TokenVariable = {
		id,
		name,
		collectionId: collection.id,
		type: input.type,
		valuesByMode,
		...(input.description ? { description: String(input.description) } : {}),
		...(input.scopes !== undefined ? { scopes: normalizeTokenScopes(input.type, input.scopes) } : {}),
	};
	if (variable.scopes === undefined) delete variable.scopes;
	const unit = normalizeUnit(input.unit);
	if (unit) variable.unit = unit;
	return { state: { ...state, variables: [...state.variables, variable] }, variable };
}

/**
 * Sets a variable's value in one mode (id or name; default: the default mode) to a literal or
 * `{ alias: variableId }`. Aliases must keep the type and not create a cycle.
 */
export function setTokenValue(state: TokenState, variableId: string, value: unknown, modeId?: string): TokenState {
	const variable = requireVariable(state, variableId);
	const collection = requireCollection(state, variable.collectionId);
	const mode = modeId === undefined ? collection.modes[0] : requireMode(collection, modeId);
	const prepared = prepareTokenValue(state, variable, value);
	const current = variable.valuesByMode[mode.id];
	if (current === prepared || (isTokenAlias(current) && isTokenAlias(prepared) && current.alias === prepared.alias)) return state;
	return replaceVariable(state, { ...variable, valuesByMode: { ...variable.valuesByMode, [mode.id]: prepared } });
}

export function renameTokenVariable(state: TokenState, variableId: string, name: string): TokenState {
	const variable = requireVariable(state, variableId);
	const next = normalizeTokenName(name);
	if (next === variable.name) return state;
	checkVariableName(state, variable.collectionId, next, variable.id);
	return replaceVariable(state, { ...variable, name: next });
}

export interface UpdateTokenVariableInput {
	description?: string;
	/** `null` clears the limit (every property). */
	scopes?: readonly string[] | null;
	/** `null` clears the unit. */
	unit?: string | null;
}

export function updateTokenVariable(state: TokenState, variableId: string, input: UpdateTokenVariableInput): TokenState {
	const variable = requireVariable(state, variableId);
	const next: TokenVariable = { ...variable };
	if (input.description !== undefined) {
		if (input.description) next.description = String(input.description);
		else delete next.description;
	}
	if (input.scopes !== undefined) {
		const scopes = normalizeTokenScopes(variable.type, input.scopes);
		if (scopes) next.scopes = scopes;
		else delete next.scopes;
	}
	if (input.unit !== undefined) {
		const unit = normalizeUnit(input.unit);
		if (unit) next.unit = unit;
		else delete next.unit;
	}
	return replaceVariable(state, next);
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted state

export interface TokenStateIssue {
	message: string;
	collectionId?: string;
	variableId?: string;
}

/**
 * Reads untrusted data (e.g. a saved `TokenState`) and keeps what is valid: junk collections,
 * modes and variables are dropped, bad values replaced by the type's default and alias cycles
 * broken, each with an issue.
 */
export function parseTokenState(input: unknown): { state: TokenState; issues: TokenStateIssue[] } {
	const issues: TokenStateIssue[] = [];
	let raw = input;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { state: { collections: [], variables: [] }, issues: [{ message: 'Not JSON' }] };
		}
	}
	const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const collections: TokenCollection[] = [];
	const ids = new Set<string>();
	for (const c of Array.isArray(obj.collections) ? obj.collections : []) {
		const item = c as Partial<TokenCollection> | null;
		const modes = Array.isArray(item?.modes)
			? (item!.modes as unknown[]).filter(
					(m): m is TokenMode => typeof m === 'object' && m !== null && typeof (m as TokenMode).id === 'string' && typeof (m as TokenMode).name === 'string'
				)
			: [];
		if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || modes.length === 0 || ids.has(item.id)) {
			issues.push({ message: 'Dropped an invalid collection' });
			continue;
		}
		ids.add(item.id);
		collections.push({ id: item.id, name: item.name, modes: modes.map((m) => ({ id: m.id, name: m.name })) });
	}
	const byId = new Map(collections.map((c) => [c.id, c]));
	const variables: TokenVariable[] = [];
	const varIds = new Set<string>();
	for (const v of Array.isArray(obj.variables) ? obj.variables : []) {
		const item = v as Partial<TokenVariable> | null;
		const collection = item && typeof item.collectionId === 'string' ? byId.get(item.collectionId) : undefined;
		if (
			!item ||
			typeof item.id !== 'string' ||
			typeof item.name !== 'string' ||
			!collection ||
			!(['color', 'number', 'string', 'boolean'] as unknown[]).includes(item.type) ||
			varIds.has(item.id)
		) {
			issues.push({ message: 'Dropped an invalid variable', variableId: typeof item?.id === 'string' ? item.id : undefined });
			continue;
		}
		varIds.add(item.id);
		const type = item.type as TokenType;
		const values: Record<string, TokenValue> = {};
		const rawValues = (typeof item.valuesByMode === 'object' && item.valuesByMode !== null ? item.valuesByMode : {}) as Record<string, unknown>;
		for (const mode of collection.modes) {
			const value = rawValues[mode.id];
			if (isTokenAlias(value)) values[mode.id] = { alias: value.alias };
			else {
				const literal = coerceTokenLiteral(type, value);
				if (literal === null) issues.push({ message: `\`${item.name}\` had no valid value in \`${mode.name}\``, variableId: item.id });
				values[mode.id] = literal ?? defaultTokenValue(type);
			}
		}
		const variable: TokenVariable = { id: item.id, name: item.name, collectionId: collection.id, type, valuesByMode: values };
		if (typeof item.description === 'string' && item.description) variable.description = item.description;
		if (Array.isArray(item.scopes)) {
			try {
				const scopes = normalizeTokenScopes(type, item.scopes as string[]);
				if (scopes) variable.scopes = scopes;
			} catch {
				issues.push({ message: `Dropped unknown scopes of \`${item.name}\``, variableId: item.id });
			}
		}
		if (typeof item.unit === 'string' && /^[a-z%]{1,8}$/i.test(item.unit)) variable.unit = item.unit.toLowerCase();
		variables.push(variable);
	}
	let state: TokenState = { collections, variables };
	// Aliases: drop missing / mistyped targets and break cycles.
	const fixed = state.variables.map((variable) => {
		let values: Record<string, TokenValue> | null = null;
		for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
			if (!isTokenAlias(value)) continue;
			const target = state.variables.find((t) => t.id === value.alias);
			if (!target || target.type !== variable.type) {
				values ??= { ...variable.valuesByMode };
				values[modeId] = defaultTokenValue(variable.type);
				issues.push({ message: `\`${variable.name}\` aliased a missing or mistyped variable`, variableId: variable.id });
			}
		}
		return values ? { ...variable, valuesByMode: values } : variable;
	});
	state = { collections, variables: fixed };
	// Cycle breaking: rebuild alias by alias, keeping only those that do not close a loop.
	const literalOnly = fixed.map((variable) => {
		const values: Record<string, TokenValue> = {};
		for (const [modeId, value] of Object.entries(variable.valuesByMode)) values[modeId] = isTokenAlias(value) ? defaultTokenValue(variable.type) : value;
		return { ...variable, valuesByMode: values };
	});
	let rebuilt: TokenState = { collections, variables: literalOnly };
	for (const variable of fixed) {
		for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
			if (!isTokenAlias(value)) continue;
			const error = checkTokenAlias(rebuilt, variable, value.alias);
			if (error) {
				issues.push({ message: `\`${variable.name}\`: ${error.message}`, variableId: variable.id });
				continue;
			}
			const current = getTokenVariable(rebuilt, variable.id)!;
			rebuilt = replaceVariable(rebuilt, { ...current, valuesByMode: { ...current.valuesByMode, [modeId]: { alias: value.alias } } });
		}
	}
	return { state: rebuilt, issues };
}
