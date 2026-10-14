// Portions ported from filmcraft-main/crates/engine/src/shortcuts.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import {
	chordToString,
	detectPlatform,
	effectiveChord,
	effectiveChordKey,
	shortcutCode,
	isEditableEventTarget,
	parseChord,
	PLATFORMS,
	type Chord,
	type KeyboardEventLike,
	type Platform
} from './chords.js';

/** One key binding: a chord that runs `command`, optionally only in one scope / on some platforms. */
export interface ShortcutBinding {
	command: string;
	/** Chord text (`Mod+Shift+Z`) or a parsed chord. */
	chord: string | Chord;
	/** Scope (e.g. `canvas`, `spreadsheet`); scoped bindings win over global ones. Omit for global. */
	scope?: string;
	/** Platforms the binding exists on (default: all). E.g. `Mod+Y` redo only off macOS. */
	platforms?: readonly Platform[];
	/** Also fire while focus is in an input, textarea or contenteditable (default `false`). */
	allowInEditable?: boolean;
}

/** Shortcut declaration on a command: chord text, or an object for platform / scope specifics. */
export type ShortcutInput =
	| string
	| Omit<ShortcutBinding, 'command'>
	| ReadonlyArray<string | Omit<ShortcutBinding, 'command'>>;

/** Expands a command's `shortcut` declaration into bindings. */
export function toShortcutBindings(command: string, input: ShortcutInput | undefined, scope?: string): ShortcutBinding[] {
	if (input === undefined) return [];
	const list = (Array.isArray(input) ? input : [input]) as Array<string | Omit<ShortcutBinding, 'command'>>;
	return list.map((item) =>
		typeof item === 'string'
			? { command, chord: item, ...(scope ? { scope } : {}) }
			: { ...item, command, ...(item.scope ?? scope ? { scope: item.scope ?? scope } : {}) }
	);
}

export interface ShortcutConflict {
	/** Scope shared by the bindings (`undefined` = global). */
	scope?: string;
	/** Effective chord, e.g. `Ctrl+KeyZ`. */
	chord: string;
	/** Commands bound to it (two or more). */
	commands: string[];
}

export interface ShortcutMatch {
	command: string;
	binding: ShortcutBinding;
}

export interface ShortcutResolveOptions {
	/** Active scopes, most specific first. Bindings in these scopes win over global ones. */
	scopes?: string | readonly string[];
	/** Resolve even when the event comes from a text input (default: per binding). */
	allowInEditable?: boolean;
	/** Override the map's platform. */
	platform?: Platform;
}

export interface ShortcutMapOptions {
	/** Platform used to resolve `Mod` (default: detected from `navigator` on every resolve). */
	platform?: Platform;
	/**
	 * `platform` (default): `Mod` means ⌘ on macOS and Ctrl elsewhere, exactly.
	 * `either`: `Mod` (and `Ctrl` / `Meta`) match ⌘ or Ctrl on every platform.
	 */
	modifierMode?: 'platform' | 'either';
}

interface Entry {
	binding: ShortcutBinding;
	chord: Chord;
	source: 'default' | 'override';
}

const asList = (scopes: string | readonly string[] | undefined): readonly string[] =>
	scopes === undefined ? [] : typeof scopes === 'string' ? [scopes] : scopes;

/**
 * Keyboard shortcuts as data: default bindings plus user overrides, resolved from
 * `KeyboardEvent`s by `event.code` (so Option/Alt chords work on macOS), with scopes
 * (scoped bindings win), conflict detection per platform and display formatting.
 */
export class ShortcutMap {
	private defaults: Entry[] = [];
	private overrides = new Map<string, Entry[]>();
	private readonly listeners = new Set<() => void>();
	private readonly options: ShortcutMapOptions;

	constructor(bindings: readonly ShortcutBinding[] = [], options: ShortcutMapOptions = {}) {
		this.options = options;
		for (const binding of bindings) this.defaults.push(this.entry(binding, 'default'));
	}

	get platform(): Platform {
		return this.options.platform ?? detectPlatform();
	}

	private entry(binding: ShortcutBinding, source: Entry['source']): Entry {
		return { binding, chord: typeof binding.chord === 'string' ? parseChord(binding.chord) : binding.chord, source };
	}

	private changed() {
		for (const listener of Array.from(this.listeners)) listener();
	}

	/** Subscribes to binding changes. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Adds default bindings (throws on invalid chord text). Returns a function removing them. */
	bind(bindings: ShortcutBinding | readonly ShortcutBinding[]): () => void {
		const added = (Array.isArray(bindings) ? bindings : [bindings]).map((b) => this.entry(b as ShortcutBinding, 'default'));
		if (added.length === 0) return () => {};
		this.defaults.push(...added);
		this.changed();
		return () => {
			const before = this.defaults.length;
			this.defaults = this.defaults.filter((e) => !added.includes(e));
			if (this.defaults.length !== before) this.changed();
		};
	}

	/**
	 * User override for a command: replaces all of its default bindings with `chords`
	 * (an empty list unbinds it). Throws on invalid chord text.
	 */
	setOverride(
		command: string,
		chords: string | Chord | ReadonlyArray<string | Chord | Omit<ShortcutBinding, 'command'>>
	): void {
		const list = (Array.isArray(chords) ? chords : [chords]) as Array<string | Chord | Omit<ShortcutBinding, 'command'>>;
		const entries = list.map((item) =>
			this.entry(
				typeof item === 'string' || !('chord' in item) ? { command, chord: item as string | Chord } : { ...item, command },
				'override'
			)
		);
		this.overrides.set(command, entries);
		this.changed();
	}

	/** Removes a user override (the defaults apply again). */
	clearOverride(command: string): void {
		if (this.overrides.delete(command)) this.changed();
	}

	/** User overrides as plain data (`{ command: ['Mod+K'] }`), e.g. to persist them. */
	getOverrides(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [command, entries] of this.overrides) {
			out[command] = entries.map((e) => chordToString(e.chord));
		}
		return out;
	}

	/** Restores overrides saved with `getOverrides` (replacing the current ones). */
	setOverrides(overrides: Record<string, readonly string[]>): void {
		this.overrides.clear();
		for (const [command, chords] of Object.entries(overrides)) {
			this.overrides.set(
				command,
				chords.map((chord) => this.entry({ command, chord }, 'override'))
			);
		}
		this.changed();
	}

	private active(platform: Platform): Entry[] {
		const out: Entry[] = [];
		for (const e of this.defaults) {
			if (!this.overrides.has(e.binding.command)) out.push(e);
		}
		for (const entries of this.overrides.values()) out.push(...entries);
		return out.filter((e) => !e.binding.platforms || e.binding.platforms.includes(platform));
	}

	/** Effective bindings on `platform` (defaults without overridden commands, plus overrides). */
	bindings(platform: Platform = this.platform): ShortcutBinding[] {
		return this.active(platform).map((e) => e.binding);
	}

	/** Canonical chord text bound to `command` on `platform` (first = primary). */
	forCommand(command: string, platform: Platform = this.platform): string[] {
		return this.active(platform)
			.filter((e) => e.binding.command === command)
			.map((e) => chordToString(e.chord));
	}

	/**
	 * The command a keydown event runs, or `null`. Events from text inputs are ignored
	 * unless the binding (or `options`) allows them. Bindings in the active scopes
	 * (in order) win over global bindings; bindings in other scopes never match.
	 * Keys are matched by `event.code`, except that a letter key producing another Latin
	 * letter (AZERTY, QWERTZ, Dvorak) matches that letter when Alt is not held, so
	 * `Mod+Z` follows the Z label (see `shortcutCode`).
	 */
	resolve(event: KeyboardEventLike, options: ShortcutResolveOptions = {}): ShortcutMatch | null {
		const platform = options.platform ?? this.platform;
		const editable = isEditableEventTarget(event);
		const scopes = asList(options.scopes);
		const candidates = this.active(platform).filter(
			(e) => !editable || (options.allowInEditable ?? e.binding.allowInEditable ?? false)
		);
		if (candidates.length === 0) return null;
		const code = shortcutCode(event);
		const matching = candidates.filter((e) => this.matches(e.chord, code, event, platform));
		if (matching.length === 0) return null;
		for (const scope of scopes) {
			const found = matching.find((e) => e.binding.scope === scope);
			if (found) return { command: found.binding.command, binding: found.binding };
		}
		const global = matching.find((e) => e.binding.scope === undefined);
		if (global) return { command: global.binding.command, binding: global.binding };
		return null;
	}

	private matches(chord: Chord, code: string, event: KeyboardEventLike, platform: Platform): boolean {
		if (chord.key !== code) return false;
		if (!!chord.alt !== !!event.altKey || !!chord.shift !== !!event.shiftKey) return false;
		if (this.options.modifierMode === 'either') {
			return !!(chord.mod || chord.ctrl || chord.meta) === !!(event.ctrlKey || event.metaKey);
		}
		const e = effectiveChord(chord, platform);
		return e.ctrl === !!event.ctrlKey && e.meta === !!event.metaKey;
	}

	/**
	 * Groups of bindings that share an effective chord in one scope on `platform`
	 * (e.g. `Mod+Y` and `Ctrl+Y` collide off macOS). A scoped binding shadowing a
	 * global one is not a conflict.
	 */
	findConflicts(platform: Platform = this.platform): ShortcutConflict[] {
		const groups = new Map<string, ShortcutConflict>();
		for (const e of this.active(platform)) {
			const chord = this.options.modifierMode === 'either' ? eitherKey(e.chord) : effectiveChordKey(e.chord, platform);
			const id = `${e.binding.scope ?? ''}\u0000${chord}`;
			const group = groups.get(id) ?? { ...(e.binding.scope ? { scope: e.binding.scope } : {}), chord, commands: [] };
			if (!group.commands.includes(e.binding.command)) group.commands.push(e.binding.command);
			groups.set(id, group);
		}
		return [...groups.values()].filter((g) => g.commands.length > 1);
	}

	/** Conflicts on every platform, keyed by platform (only platforms with conflicts). */
	findAllConflicts(): Partial<Record<Platform, ShortcutConflict[]>> {
		const out: Partial<Record<Platform, ShortcutConflict[]>> = {};
		for (const p of PLATFORMS) {
			const conflicts = this.findConflicts(p);
			if (conflicts.length) out[p] = conflicts;
		}
		return out;
	}
}

function eitherKey(chord: Chord): string {
	return [(chord.mod || chord.ctrl || chord.meta) && 'Mod', chord.alt && 'Alt', chord.shift && 'Shift', chord.key]
		.filter(Boolean)
		.join('+');
}
