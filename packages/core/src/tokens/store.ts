import {
	addTokenMode,
	createTokenCollection,
	createTokenVariable,
	defaultTokenId,
	deleteTokenCollection,
	deleteTokenVariables,
	moveTokenMode,
	parseTokenState,
	removeTokenMode,
	renameTokenCollection,
	renameTokenMode,
	renameTokenVariable,
	resolveToken,
	resolveTokenValue,
	setTokenValue,
	updateTokenVariable,
	type CreateTokenCollectionInput,
	type CreateTokenVariableInput,
	type TokenIdFactory,
	type TokenResolution,
	type UpdateTokenVariableInput
} from './model.js';
import type { TokenCollection, TokenLiteral, TokenMode, TokenModeContext, TokenState, TokenVariable } from './types.js';
import { EMPTY_TOKEN_STATE } from './types.js';

/** Why the state changed. */
export type TokenChangeSource = 'edit' | 'undo' | 'redo' | 'replace';

export interface TokenChangeEvent {
	source: TokenChangeSource;
	/** Operation name (`setValue`, `deleteVariables`, a `transact` label, …). */
	reason: string;
	state: TokenState;
	previous: TokenState;
	/**
	 * Variables this edit deleted (also via `deleteCollection`). Detach canvas bindings to them
	 * with `detachTokenBindings(nodes, event.previous, event.deletedVariableIds)`.
	 */
	deletedVariableIds: readonly string[];
}

export type TokenChangeListener = (event: TokenChangeEvent) => void;

export interface TokenStoreOptions {
	initialState?: TokenState;
	createId?: TokenIdFactory;
	/** Undo steps kept (default 100). */
	historyLimit?: number;
}

interface Pending {
	reason: string;
	previous: TokenState;
	deleted: string[];
}

/**
 * Undoable design-token store. Every edit is one undo step (group several with `transact`)
 * and notifies subscribers once. `getState()` returns an immutable snapshot whose reference
 * only changes on edits, so it works with `useSyncExternalStore` and Svelte stores.
 * Refused edits throw a `TokenError` and change nothing.
 */
export class TokenStore {
	private state: TokenState;
	private undoStack: { state: TokenState; reason: string }[] = [];
	private redoStack: { state: TokenState; reason: string }[] = [];
	private listeners = new Set<TokenChangeListener>();
	private pending: Pending | null = null;
	private depth = 0;
	private readonly createId: TokenIdFactory;
	private readonly historyLimit: number;

	constructor(options: TokenStoreOptions = {}) {
		this.state = options.initialState ?? EMPTY_TOKEN_STATE;
		this.createId = options.createId ?? defaultTokenId;
		this.historyLimit = Math.max(0, options.historyLimit ?? 100);
	}

	getState = (): TokenState => this.state;

	subscribe = (listener: TokenChangeListener): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	get collections(): readonly TokenCollection[] {
		return this.state.collections;
	}

	get variables(): readonly TokenVariable[] {
		return this.state.variables;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Resolves a variable under `modes` (see `resolveToken`). */
	resolve(id: string, modes?: TokenModeContext): TokenResolution {
		return resolveToken(this.state, id, modes);
	}

	resolveValue(id: string, modes?: TokenModeContext): TokenLiteral | undefined {
		return resolveTokenValue(this.state, id, modes);
	}

	/**
	 * Runs `fn` as one undo step with one change event. If `fn` throws, every change it made is
	 * rolled back and the error rethrown.
	 */
	transact<T>(reason: string, fn: (store: this) => T): T {
		const outer = this.depth === 0;
		if (outer) this.pending = { reason, previous: this.state, deleted: [] };
		this.depth += 1;
		try {
			const result = fn(this);
			this.depth -= 1;
			if (outer) this.flush();
			return result;
		} catch (error) {
			this.depth -= 1;
			if (outer) {
				this.state = this.pending!.previous;
				this.pending = null;
			}
			throw error;
		}
	}

	private apply(reason: string, next: TokenState, deleted: readonly string[] = []): void {
		if (next === this.state) return;
		if (this.depth > 0) {
			this.state = next;
			this.pending!.deleted.push(...deleted);
			return;
		}
		this.pending = { reason, previous: this.state, deleted: [...deleted] };
		this.state = next;
		this.flush();
	}

	private flush(): void {
		const pending = this.pending!;
		this.pending = null;
		if (pending.previous === this.state) return;
		this.undoStack.push({ state: pending.previous, reason: pending.reason });
		if (this.undoStack.length > this.historyLimit) this.undoStack.splice(0, this.undoStack.length - this.historyLimit);
		this.redoStack = [];
		this.emit({ source: 'edit', reason: pending.reason, state: this.state, previous: pending.previous, deletedVariableIds: pending.deleted });
	}

	private emit(event: TokenChangeEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	undo(): boolean {
		const entry = this.undoStack.pop();
		if (!entry) return false;
		const previous = this.state;
		this.redoStack.push({ state: previous, reason: entry.reason });
		this.state = entry.state;
		this.emit({ source: 'undo', reason: entry.reason, state: this.state, previous, deletedVariableIds: [] });
		return true;
	}

	redo(): boolean {
		const entry = this.redoStack.pop();
		if (!entry) return false;
		const previous = this.state;
		this.undoStack.push({ state: previous, reason: entry.reason });
		this.state = entry.state;
		this.emit({ source: 'redo', reason: entry.reason, state: this.state, previous, deletedVariableIds: [] });
		return true;
	}

	/**
	 * Replaces the whole state (e.g. after loading a file). Untrusted data should go through
	 * `parseTokenState` first. With `record: true` it is an undo step; otherwise history is cleared.
	 */
	replaceState(state: TokenState, options: { record?: boolean; reason?: string } = {}): void {
		if (options.record) {
			this.apply(options.reason ?? 'replace', state);
			return;
		}
		const previous = this.state;
		this.state = state;
		this.undoStack = [];
		this.redoStack = [];
		this.emit({ source: 'replace', reason: options.reason ?? 'replace', state, previous, deletedVariableIds: [] });
	}

	/** Loads untrusted JSON (or an object) as the new state; returns the issues found. */
	load(input: unknown): ReturnType<typeof parseTokenState>['issues'] {
		const { state, issues } = parseTokenState(input);
		this.replaceState(state, { reason: 'load' });
		return issues;
	}

	/** The state as JSON. */
	toJSON(): TokenState {
		return this.state;
	}

	// --- Collections and modes -----------------------------------------------------------------

	createCollection(name: string, modes?: readonly string[]): TokenCollection {
		const input: CreateTokenCollectionInput = { name, modes };
		const result = createTokenCollection(this.state, input, this.createId);
		this.apply('createCollection', result.state);
		return result.collection;
	}

	renameCollection(id: string, name: string): void {
		this.apply('renameCollection', renameTokenCollection(this.state, id, name));
	}

	deleteCollection(id: string): string[] {
		const result = deleteTokenCollection(this.state, id);
		this.apply('deleteCollection', result.state, result.deleted);
		return result.deleted;
	}

	addMode(collectionId: string, name: string, options: { from?: string } = {}): TokenMode {
		const result = addTokenMode(this.state, collectionId, name, options, this.createId);
		this.apply('addMode', result.state);
		return result.mode;
	}

	renameMode(collectionId: string, modeId: string, name: string): void {
		this.apply('renameMode', renameTokenMode(this.state, collectionId, modeId, name));
	}

	removeMode(collectionId: string, modeId: string): void {
		this.apply('removeMode', removeTokenMode(this.state, collectionId, modeId));
	}

	moveMode(collectionId: string, modeId: string, to: number): void {
		this.apply('moveMode', moveTokenMode(this.state, collectionId, modeId, to));
	}

	/** Makes a mode the default by moving it first. */
	setDefaultMode(collectionId: string, modeId: string): void {
		this.apply('setDefaultMode', moveTokenMode(this.state, collectionId, modeId, 0));
	}

	// --- Variables -----------------------------------------------------------------------------

	createVariable(input: CreateTokenVariableInput): TokenVariable {
		const result = createTokenVariable(this.state, input, this.createId);
		this.apply('createVariable', result.state);
		return result.variable;
	}

	/** Sets a literal or `{ alias }` in one mode (id or name; default: the default mode). */
	setValue(variableId: string, value: unknown, modeId?: string): void {
		this.apply('setValue', setTokenValue(this.state, variableId, value, modeId));
	}

	renameVariable(variableId: string, name: string): void {
		this.apply('renameVariable', renameTokenVariable(this.state, variableId, name));
	}

	updateVariable(variableId: string, input: UpdateTokenVariableInput): void {
		this.apply('updateVariable', updateTokenVariable(this.state, variableId, input));
	}

	/** Deletes variables; aliases to them take their values. Returns the ids deleted. */
	deleteVariables(ids: string | Iterable<string>): string[] {
		const result = deleteTokenVariables(this.state, typeof ids === 'string' ? [ids] : ids);
		this.apply('deleteVariables', result.state, result.deleted);
		return result.deleted;
	}

	/** Applies a pure state transform (e.g. `importW3CTokens`) as one undo step. */
	update(reason: string, fn: (state: TokenState) => TokenState): void {
		this.apply(reason, fn(this.state));
	}
}

export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
	return new TokenStore(options);
}
