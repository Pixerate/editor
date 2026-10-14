// Portions ported from figcraft/crates/doc/src/styles.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Design tokens (Figma-style "variables"): collections hold modes (e.g. Light / Dark) and
 * typed variables with one value per mode. A value is a literal or an alias to another
 * variable of the same type, possibly in another collection.
 *
 * The state is plain, immutable, JSON-serialisable data. Every operation returns a new state.
 */

/** A variable's type. */
export type TokenType = 'color' | 'number' | 'string' | 'boolean';

export const TOKEN_TYPES: readonly TokenType[] = ['color', 'number', 'string', 'boolean'];

/** A resolved value: colours are normalised hex strings (`#rrggbb` or `#rrggbbaa`). */
export type TokenLiteral = string | number | boolean;

/** A reference to another variable (by id). */
export interface TokenAlias {
	alias: string;
}

/** What a variable holds in one mode. */
export type TokenValue = TokenLiteral | TokenAlias;

export interface TokenMode {
	id: string;
	name: string;
}

export interface TokenCollection {
	id: string;
	name: string;
	/** At least one mode. The first one is the default mode. */
	modes: readonly TokenMode[];
}

/**
 * Which properties pickers offer a variable for (figcraft / Figma scope ids). Scopes only
 * filter pickers: binding out of scope still works.
 */
export type TokenScope =
	| 'ALL_SCOPES'
	| 'ALL_FILLS'
	| 'FRAME_FILL'
	| 'SHAPE_FILL'
	| 'TEXT_FILL'
	| 'STROKE_COLOR'
	| 'EFFECT_COLOR'
	| 'CORNER_RADIUS'
	| 'WIDTH_HEIGHT'
	| 'GAP'
	| 'OPACITY'
	| 'STROKE_FLOAT'
	| 'EFFECT_FLOAT'
	| 'FONT_WEIGHT'
	| 'FONT_SIZE'
	| 'LINE_HEIGHT'
	| 'LETTER_SPACING'
	| 'PARAGRAPH_SPACING'
	| 'PARAGRAPH_INDENT'
	| 'TEXT_CONTENT'
	| 'FONT_FAMILY'
	| 'FONT_STYLE';

export interface TokenVariable {
	id: string;
	/** Unique within its collection. `/` separates groups (`color/bg`). */
	name: string;
	collectionId: string;
	type: TokenType;
	/** Value per mode id of the collection. */
	valuesByMode: Readonly<Record<string, TokenValue>>;
	description?: string;
	/** Pickers offer the variable for these scopes; `undefined` = every supported property. */
	scopes?: readonly TokenScope[];
	/** Unit for number variables in CSS / W3C export (`px`, `rem`, `ms`, …). */
	unit?: string;
}

export interface TokenState {
	collections: readonly TokenCollection[];
	variables: readonly TokenVariable[];
}

/**
 * Chosen mode per collection: `{ [collectionId]: modeId }`. Collections not listed (or with an
 * unknown mode) use their default (first) mode.
 */
export type TokenModeContext = Readonly<Record<string, string>>;

export type TokenErrorCode =
	| 'not-found'
	| 'invalid-name'
	| 'duplicate-name'
	| 'name-conflict'
	| 'invalid-type'
	| 'invalid-value'
	| 'type-mismatch'
	| 'alias-missing'
	| 'alias-cycle'
	| 'last-mode'
	| 'unknown-scope'
	| 'invalid-input';

/** Thrown by token operations that are refused; `code` says why. */
export class TokenError extends Error {
	readonly code: TokenErrorCode;
	constructor(code: TokenErrorCode, message: string) {
		super(message);
		this.name = 'TokenError';
		this.code = code;
	}
}

export function isTokenAlias(value: unknown): value is TokenAlias {
	return typeof value === 'object' && value !== null && typeof (value as TokenAlias).alias === 'string';
}

export const EMPTY_TOKEN_STATE: TokenState = Object.freeze({ collections: Object.freeze([]), variables: Object.freeze([]) }) as TokenState;
