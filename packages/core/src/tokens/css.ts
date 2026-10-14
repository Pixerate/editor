// Portions ported from figcraft/crates/engine/src/variables_io_tests.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { getCurrentMode, getTokenCollection, getTokenVariable, resolveToken } from './model.js';
import { isTokenAlias, type TokenCollection, type TokenLiteral, type TokenMode, type TokenModeContext, type TokenState, type TokenVariable } from './types.js';

export interface TokenCssOptions {
	/** Collections to export (ids; default all). */
	collections?: readonly string[];
	/** Prefix after `--` (e.g. `ds-` → `--ds-color-bg`). */
	prefix?: string;
	/** Also prefix each variable with its collection name (avoids clashes between collections). */
	collectionPrefix?: boolean;
	/** Root selector (default `:root`). */
	selector?: string;
	/** Attribute that selects a mode (default `data-mode`), or one per collection. */
	attribute?: string | ((collection: TokenCollection) => string);
	/** Attribute value for a mode (default: the mode name as a lowercase slug, e.g. `dark`). */
	modeValue?: (mode: TokenMode, collection: TokenCollection) => string;
	/**
	 * Also emit `[data-mode="…"]` rules that match any element (not just the root), so a subtree
	 * can switch mode. Default `false`.
	 */
	nested?: boolean;
	/** Formats numbers (default: the number with the variable's `unit`, if any). */
	formatNumber?: (value: number, variable: TokenVariable) => string;
}

/** Lowercase slug of a name: groups and spaces become `-` (`Color/Bg Muted` → `color-bg-muted`). */
export function tokenSlug(name: string): string {
	let out = '';
	let dash = false;
	for (const ch of name.toLowerCase()) {
		if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_') {
			if (dash && out) out += '-';
			out += ch;
			dash = false;
		} else dash = true;
	}
	return out || 'token';
}

/** The CSS custom property for a variable (e.g. `--color-bg`). */
export function getTokenCssName(state: TokenState, variable: TokenVariable, options: Pick<TokenCssOptions, 'prefix' | 'collectionPrefix'> = {}): string {
	const collection = getTokenCollection(state, variable.collectionId);
	const head = options.collectionPrefix && collection ? `${tokenSlug(collection.name)}-` : '';
	const prefix = options.prefix ? `${tokenSlug(options.prefix)}-` : '';
	return `--${prefix}${head}${tokenSlug(variable.name)}`;
}

/** A CSS string literal with `"`, `\`, newlines and `<` escaped. */
export function cssString(value: string): string {
	let out = '"';
	for (const ch of value) {
		if (ch === '"' || ch === '\\') out += '\\' + ch;
		else if (ch === '\n') out += '\\a ';
		else if (ch === '\r') out += '\\d ';
		else if (ch === '<') out += '\\3c ';
		else out += ch;
	}
	return out + '"';
}

/** A literal as CSS. */
export function formatTokenCssValue(value: TokenLiteral, variable: TokenVariable, options: Pick<TokenCssOptions, 'formatNumber'> = {}): string {
	switch (variable.type) {
		case 'color':
			return String(value);
		case 'number':
			return options.formatNumber ? options.formatNumber(value as number, variable) : `${value}${variable.unit ?? ''}`;
		case 'string':
			return cssString(String(value));
		case 'boolean':
			return value ? 'true' : 'false';
	}
}

const defaultModeValue = (mode: TokenMode) => tokenSlug(mode.name);

function attributeFor(options: TokenCssOptions, collection: TokenCollection): string {
	const attr = typeof options.attribute === 'function' ? options.attribute(collection) : options.attribute ?? 'data-mode';
	return tokenSlug(attr);
}

/**
 * Flat CSS custom properties per mode: each collection's default mode on `:root`, its other
 * modes on `:root[data-mode="dark"]`. Aliases to exported variables become `var(--target)`, so
 * switching the attribute re-themes everything; aliases to other variables are resolved.
 */
export function exportTokensCss(state: TokenState, options: TokenCssOptions = {}): string {
	const selector = options.selector ?? ':root';
	const wanted = options.collections ? new Set(options.collections) : null;
	const collections = state.collections.filter((c) => !wanted || wanted.has(c.id));
	const exported = new Set(state.variables.filter((v) => collections.some((c) => c.id === v.collectionId)).map((v) => v.id));
	const modeValue = options.modeValue ?? defaultModeValue;

	const declaration = (variable: TokenVariable, collection: TokenCollection, mode: TokenMode): string | null => {
		const value = variable.valuesByMode[mode.id];
		if (isTokenAlias(value) && exported.has(value.alias)) {
			const target = getTokenVariable(state, value.alias)!;
			return `  ${getTokenCssName(state, variable, options)}: var(${getTokenCssName(state, target, options)});`;
		}
		const resolved = resolveToken(state, variable.id, { [collection.id]: mode.id });
		if (!resolved.ok) return null;
		return `  ${getTokenCssName(state, variable, options)}: ${formatTokenCssValue(resolved.value, variable, options)};`;
	};

	const blocks: string[] = [];
	const rootLines: string[] = [];
	for (const collection of collections) {
		const vars = state.variables.filter((v) => v.collectionId === collection.id);
		for (const v of vars) {
			const line = declaration(v, collection, collection.modes[0]);
			if (line) rootLines.push(line);
		}
	}
	const rootSelectors = [selector];
	if (options.nested) {
		for (const collection of collections) {
			rootSelectors.push(`[${attributeFor(options, collection)}="${tokenSlug(modeValue(collection.modes[0], collection))}"]`);
		}
	}
	blocks.push(`${[...new Set(rootSelectors)].join(', ')} {\n${rootLines.join('\n')}${rootLines.length ? '\n' : ''}}`);
	for (const collection of collections) {
		const vars = state.variables.filter((v) => v.collectionId === collection.id);
		const attr = attributeFor(options, collection);
		for (const mode of collection.modes.slice(1)) {
			const lines = vars.map((v) => declaration(v, collection, mode)).filter((l): l is string => l !== null);
			const value = tokenSlug(modeValue(mode, collection));
			const selectors = [`${selector}[${attr}="${value}"]`];
			if (options.nested) selectors.push(`[${attr}="${value}"]`);
			blocks.push(`${selectors.join(', ')} {\n${lines.join('\n')}${lines.length ? '\n' : ''}}`);
		}
	}
	return blocks.join('\n\n') + '\n';
}

/**
 * Resolved CSS custom properties for one mode context, e.g. for an element's inline style:
 * `{ '--color-bg': '#ffffff', … }`. Aliases are resolved (no `var()`).
 */
export function getTokenCssVariables(
	state: TokenState,
	modes?: TokenModeContext,
	options: Omit<TokenCssOptions, 'selector' | 'attribute' | 'modeValue' | 'nested'> = {}
): Record<string, string> {
	const wanted = options.collections ? new Set(options.collections) : null;
	const out: Record<string, string> = {};
	for (const variable of state.variables) {
		if (wanted && !wanted.has(variable.collectionId)) continue;
		const collection = getTokenCollection(state, variable.collectionId);
		if (!collection) continue;
		const resolved = resolveToken(state, variable.id, { ...modes, [collection.id]: getCurrentMode(collection, modes).id });
		if (resolved.ok) out[getTokenCssName(state, variable, options)] = formatTokenCssValue(resolved.value, variable, options);
	}
	return out;
}
