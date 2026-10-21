// Portions ported from filmcraft-main/crates/engine/src/commands.rs and crates/engine/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { PlaybackPlan } from '../tools/playback.js';
import { validateJsonSchema, type JsonSchema, type SchemaValidationError } from '../tools/schema.js';
import type { KeyboardEventLike, Platform } from './chords.js';
import {
	ShortcutMap,
	toShortcutBindings,
	type ShortcutInput,
	type ShortcutMapOptions,
	type ShortcutResolveOptions
} from './shortcuts.js';

/** Object JSON Schema describing a command's parameters. */
export type CommandParamsSchema = JsonSchema & { type: 'object' };

/**
 * Metadata and implementation of one command. Menus, shortcuts, the palette and agent
 * tools all run commands by id, so every entry point shares enablement and validation.
 */
export interface CommandSpec<TContext = any, TParams = any, TResult = unknown> {
	/** Unique id, e.g. `history.undo` or `canvas.alignLeft`. */
	id: string;
	label: string;
	/** Group / menu name shown next to the label, e.g. `Edit` or `Arrange`. */
	group?: string;
	/** Extra search terms for the palette. */
	keywords?: readonly string[];
	description?: string;
	/** Object JSON Schema for `params`. Unknown keys are rejected unless `additionalProperties` allows them. */
	params?: CommandParamsSchema;
	/** Default shortcut(s): platform-neutral chord text such as `Mod+Shift+Z`. */
	shortcut?: ShortcutInput;
	/** Scope the command (and its shortcuts) belong to, e.g. `canvas`. Omit for global commands. */
	scope?: string;
	/**
	 * Whether the command can run: `true` (or `undefined`), `false`, or a reason string
	 * ("Nothing to undo"). Receives the params a caller named, so a command acting on the
	 * selection can still run on targets passed explicitly (`params` is `undefined` for menus).
	 */
	enabled?: (context: TContext, params: TParams | undefined) => boolean | string | undefined;
	run: (context: TContext, params: TParams) => TResult;
	/**
	 * Runs inside the registry's `history.batch(label, …)`, so all history entries the
	 * command records become one undo step and a throw rolls back its partial changes.
	 */
	undoable?: boolean;
	/** The command only reads state (agent tools mark it read-only). */
	readOnly?: boolean;
	/** Hide from the palette and `list()` unless `includeHidden` (still runnable by id). */
	hidden?: boolean;
	/**
	 * Pure planner for agent playback: the cursor steps (surface coordinates) that act out a run
	 * with these params. Without one, playback visits the ids the params name (`ids`, `layerId`, …).
	 */
	plan?: (context: TContext, params: TParams) => PlaybackPlan;
	/**
	 * The playback surface the command acts on (default: its `scope`, else the id's prefix,
	 * `canvas` for `canvas.alignLeft`).
	 */
	playbackSurface?: string;
}

export type CommandErrorCode = 'unknown_command' | 'disabled' | 'invalid_params' | 'failed';

export type CommandResult<T = unknown> =
	| { ok: true; id: string; result: T }
	| { ok: false; id: string; code: CommandErrorCode; message: string; details?: SchemaValidationError[] };

/** A command as listed for menus, palettes and agents. */
export interface CommandEntry {
	id: string;
	label: string;
	group?: string;
	keywords?: readonly string[];
	description?: string;
	params?: CommandParamsSchema;
	scope?: string;
	/** Canonical chord text bound on the registry's platform (first = primary). */
	shortcuts: string[];
	enabled: boolean;
	/** Why the command is disabled (only when `enabled` is false). */
	disabledReason?: string;
	undoable: boolean;
	readOnly: boolean;
}

export interface CommandListOptions<TContext = any> {
	/** Only global commands plus commands of these scopes. */
	scope?: string | readonly string[];
	enabledOnly?: boolean;
	includeHidden?: boolean;
	/** Context for the enablement check (default: the registry's context). */
	context?: TContext;
}

/** Minimal history surface (`HistoryManager` satisfies it). */
export interface CommandHistoryTarget {
	batch(name: string, fn: () => void): void;
}

export interface CommandRegistryOptions<TContext = any> {
	/** Default context passed to `enabled` / `run` (a value or a getter). */
	context?: TContext | (() => TContext);
	/** Wraps `undoable` commands in one history step (see `CommandSpec.undoable`). */
	history?: CommandHistoryTarget;
	/** Options for the registry's `ShortcutMap`. */
	shortcuts?: ShortcutMapOptions;
}

export class CommandRegistryError extends Error {
	readonly code: 'duplicate_command' | 'invalid_command';

	constructor(code: CommandRegistryError['code'], message: string) {
		super(message);
		this.name = 'CommandRegistryError';
		this.code = code;
	}
}

const COMMAND_ID_REGEX = /^[A-Za-z0-9_.:-]{1,128}$/;

interface Registered {
	spec: CommandSpec;
	unbind: () => void;
}

function enablement(result: boolean | string | undefined): { enabled: boolean; reason?: string } {
	if (result === undefined || result === true) return { enabled: true };
	if (result === false) return { enabled: false, reason: 'This command is not available right now.' };
	return { enabled: false, reason: String(result) };
}

/** Errors for params the command does not accept, naming the accepted keys. */
function unknownParams(spec: CommandSpec, params: Record<string, unknown>): string | null {
	const keys = Object.keys(params).filter((k) => params[k] !== undefined);
	if (keys.length === 0) return null;
	const schema = spec.params;
	if (schema && schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;
	const accepted = Object.keys(schema?.properties ?? {});
	const bad = keys.find((k) => !accepted.includes(k));
	if (!bad) return null;
	return `Unknown parameter "${bad}" for command "${spec.id}"; expected ${
		accepted.length ? accepted.map((k) => `"${k}"`).join(', ') : 'no parameters'
	}.`;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	!!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as any).then === 'function';

/**
 * Registry of commands: one id per action, shared by shortcuts (`shortcuts`), the
 * command palette (`list` + `rankCommands`) and agent tools (`createCommandToolProvider`).
 */
export class CommandRegistry<TContext = any> {
	/** Shortcut bindings of the registered commands (plus any user overrides). */
	readonly shortcuts: ShortcutMap;

	private readonly commands = new Map<string, Registered>();
	private readonly listeners = new Set<() => void>();
	private readonly options: CommandRegistryOptions<TContext>;
	private version = 0;
	// Set while register/unregister change the shortcut map, so they notify once.
	private muted = false;

	constructor(options: CommandRegistryOptions<TContext> = {}) {
		this.options = options;
		this.shortcuts = new ShortcutMap([], options.shortcuts);
		this.shortcuts.subscribe(() => {
			if (!this.muted) this.notify();
		});
	}

	/** Monotonic counter bumped on every change (useful as a snapshot key). */
	getVersion(): number {
		return this.version;
	}

	/** The default context. */
	get context(): TContext {
		const ctx = this.options.context;
		return (typeof ctx === 'function' ? (ctx as () => TContext)() : ctx) as TContext;
	}

	/**
	 * Registers a command (or several) and returns a function that unregisters it.
	 * Throws a `CommandRegistryError` for a duplicate or invalid id, or invalid chord text.
	 */
	register(spec: CommandSpec<TContext> | readonly CommandSpec<TContext>[]): () => void {
		const specs = (Array.isArray(spec) ? spec : [spec]) as CommandSpec<TContext>[];
		const seen = new Set<string>();
		for (const s of specs) {
			if (!s || typeof s.id !== 'string' || !COMMAND_ID_REGEX.test(s.id)) {
				throw new CommandRegistryError('invalid_command', `Invalid command id "${s?.id}".`);
			}
			if (typeof s.run !== 'function') {
				throw new CommandRegistryError('invalid_command', `Command "${s.id}" has no run function.`);
			}
			if (this.commands.has(s.id) || seen.has(s.id)) {
				throw new CommandRegistryError('duplicate_command', `Command "${s.id}" is already registered.`);
			}
			seen.add(s.id);
		}
		// Parse every chord before registering anything, so a bad shortcut registers nothing.
		const bindings = specs.map((s) => toShortcutBindings(s.id, s.shortcut, s.scope));
		const unbinds: Array<() => void> = [];
		this.muted = true;
		try {
			for (const b of bindings) unbinds.push(this.shortcuts.bind(b));
		} catch (error) {
			unbinds.forEach((u) => u());
			throw new CommandRegistryError('invalid_command', error instanceof Error ? error.message : String(error));
		} finally {
			this.muted = false;
		}
		specs.forEach((s, i) => this.commands.set(s.id, { spec: s, unbind: unbinds[i] }));
		this.notify();
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			let changed = false;
			for (const s of specs) {
				const entry = this.commands.get(s.id);
				if (entry && entry.spec === s) {
					this.commands.delete(s.id);
					this.unbindQuietly(entry);
					changed = true;
				}
			}
			if (changed) this.notify();
		};
	}

	/** Removes a command by id. Returns whether it was registered. */
	unregister(id: string): boolean {
		const entry = this.commands.get(id);
		if (!entry) return false;
		this.commands.delete(id);
		this.unbindQuietly(entry);
		this.notify();
		return true;
	}

	private unbindQuietly(entry: Registered) {
		this.muted = true;
		try {
			entry.unbind();
		} finally {
			this.muted = false;
		}
	}

	has(id: string): boolean {
		return this.commands.has(id);
	}

	get(id: string): CommandSpec<TContext> | undefined {
		return this.commands.get(id)?.spec;
	}

	/** Registered ids in registration order. */
	ids(): string[] {
		return [...this.commands.keys()];
	}

	/** Whether `id` can run now (`{ enabled, reason }`); `params` are the targets a caller named. */
	isEnabled(id: string, params?: unknown, context: TContext = this.context): { enabled: boolean; reason?: string } {
		const spec = this.get(id);
		if (!spec) return { enabled: false, reason: `Unknown command "${id}".` };
		if (!spec.enabled) return { enabled: true };
		try {
			return enablement(spec.enabled(context, params as any));
		} catch (error) {
			return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Commands for menus, palettes and agents, with their current enablement. */
	list(options: CommandListOptions<TContext> = {}): CommandEntry[] {
		const scopes = options.scope === undefined ? null : typeof options.scope === 'string' ? [options.scope] : options.scope;
		const context = 'context' in options ? (options.context as TContext) : this.context;
		const platform = this.shortcuts.platform;
		const out: CommandEntry[] = [];
		for (const { spec } of this.commands.values()) {
			if (spec.hidden && !options.includeHidden) continue;
			if (scopes && spec.scope !== undefined && !scopes.includes(spec.scope)) continue;
			const { enabled, reason } = this.isEnabled(spec.id, undefined, context);
			if (options.enabledOnly && !enabled) continue;
			out.push({
				id: spec.id,
				label: spec.label,
				...(spec.group !== undefined ? { group: spec.group } : {}),
				...(spec.keywords ? { keywords: spec.keywords } : {}),
				...(spec.description !== undefined ? { description: spec.description } : {}),
				...(spec.params ? { params: spec.params } : {}),
				...(spec.scope !== undefined ? { scope: spec.scope } : {}),
				shortcuts: this.shortcuts.forCommand(spec.id, platform),
				enabled,
				...(enabled ? {} : { disabledReason: reason }),
				undoable: !!spec.undoable,
				readOnly: !!spec.readOnly
			});
		}
		return out;
	}

	private check(id: string, params: unknown, context: TContext): CommandResult<never> | { spec: CommandSpec<TContext>; params: any } {
		const spec = this.get(id);
		if (!spec) return { ok: false, id, code: 'unknown_command', message: `Unknown command "${id}".` };
		const input = params ?? {};
		if (typeof input !== 'object' || Array.isArray(input)) {
			return { ok: false, id, code: 'invalid_params', message: `Parameters for command "${id}" must be an object.` };
		}
		const unknown = unknownParams(spec, input as Record<string, unknown>);
		if (unknown) return { ok: false, id, code: 'invalid_params', message: unknown };
		if (spec.params) {
			const details = validateJsonSchema(input, spec.params);
			if (details.length > 0) {
				return {
					ok: false,
					id,
					code: 'invalid_params',
					message: `Invalid parameters for command "${id}": ${details.map((d) => `${d.path} ${d.message}`).join('; ')}`,
					details
				};
			}
		}
		const { enabled, reason } = this.isEnabled(id, params === undefined ? undefined : input, context);
		if (!enabled) return { ok: false, id, code: 'disabled', message: reason ?? 'Disabled.' };
		return { spec, params: input };
	}

	/** The history `undoable` commands (and atomic agent batches) record into, if any. */
	get history(): CommandHistoryTarget | undefined {
		return this.options.history;
	}

	private invoke(spec: CommandSpec<TContext>, params: any, context: TContext): unknown {
		const history = this.options.history;
		if (!spec.undoable || !history) return spec.run(context, params);
		let value: unknown;
		// `batch` rolls back already-recorded steps and rethrows when `run` throws.
		history.batch(spec.label, () => {
			value = spec.run(context, params);
		});
		return value;
	}

	/**
	 * Runs a command synchronously and returns a structured result; never throws.
	 * A command whose `run` returns a promise yields `{ ok: true, result: promise }`
	 * (use `executeAsync` to await it and catch its rejection).
	 */
	execute<T = unknown>(id: string, params?: unknown, context: TContext = this.context): CommandResult<T> {
		const checked = this.check(id, params, context);
		if ('ok' in checked) return checked;
		try {
			const result = this.invoke(checked.spec, checked.params, context);
			this.notify();
			return { ok: true, id, result: result as T };
		} catch (error) {
			this.notify();
			return { ok: false, id, code: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Like `execute`, but awaits async commands (rejections become `failed` results). */
	async executeAsync<T = unknown>(id: string, params?: unknown, context: TContext = this.context): Promise<CommandResult<T>> {
		const outcome = this.execute<T>(id, params, context);
		if (!outcome.ok || !isThenable(outcome.result)) return outcome;
		try {
			const result = await outcome.result;
			this.notify();
			return { ok: true, id, result: result as T };
		} catch (error) {
			this.notify();
			return { ok: false, id, code: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Resolves a keydown event to a command (see `ShortcutMap.resolve`) and runs it when
	 * enabled, calling `preventDefault()`. Disabled commands leave the event alone, so the
	 * browser or a focused editor can still handle it. Returns the result, or `null`.
	 */
	handleKeyDown(
		event: KeyboardEventLike,
		options: ShortcutResolveOptions & { context?: TContext } = {}
	): CommandResult | null {
		if (event.defaultPrevented) return null;
		const match = this.shortcuts.resolve(event, options);
		if (!match) return null;
		const context = 'context' in options ? (options.context as TContext) : this.context;
		if (!this.isEnabled(match.command, undefined, context).enabled) return null;
		event.preventDefault?.();
		return this.execute(match.command, undefined, context);
	}

	/** Display-ready primary shortcut of a command (`⇧⌘Z` / `Ctrl+Shift+Z`), or `undefined`. */
	shortcutFor(id: string, platform: Platform = this.shortcuts.platform): string | undefined {
		return this.shortcuts.forCommand(id, platform)[0];
	}

	/**
	 * Subscribes to changes: commands registered or removed, shortcut overrides, executed
	 * commands and `invalidate()` calls (e.g. when enablement inputs change).
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Tells subscribers that enablement may have changed (e.g. the selection changed). */
	invalidate(): void {
		this.notify();
	}

	private notify(): void {
		this.version++;
		for (const listener of Array.from(this.listeners)) {
			try {
				listener();
			} catch (error) {
				console.error('[CommandRegistry] Error in listener:', error);
			}
		}
	}
}

export function createCommandRegistry<TContext = any>(options?: CommandRegistryOptions<TContext>): CommandRegistry<TContext> {
	return new CommandRegistry<TContext>(options);
}

/** Identity helper that types a command spec. */
export function defineCommand<TContext = any, TParams = any, TResult = unknown>(
	spec: CommandSpec<TContext, TParams, TResult>
): CommandSpec<TContext, TParams, TResult> {
	return spec;
}
