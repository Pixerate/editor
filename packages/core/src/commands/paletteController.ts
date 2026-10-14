import { formatShortcut, type KeyboardEventLike, type Platform } from './chords.js';
import { DEFAULT_RECENT_LIMIT, pushRecent, rankCommands, type RankedCommand } from './palette.js';
import type { CommandEntry, CommandRegistry, CommandResult } from './registry.js';
import { ShortcutMap } from './shortcuts.js';

/** One palette row. */
export interface CommandPaletteItem extends RankedCommand<CommandEntry> {
	id: string;
	label: string;
	group?: string;
	/** Display-ready primary shortcut (`⇧⌘Z` / `Ctrl+Shift+Z`). */
	shortcut?: string;
	enabled: boolean;
	disabledReason?: string;
}

export interface CommandPaletteState {
	open: boolean;
	query: string;
	activeIndex: number;
	items: CommandPaletteItem[];
	recents: string[];
	/** Result of the last command the palette ran. */
	lastResult: CommandResult | null;
}

export interface CommandPaletteOptions<TContext = any> {
	/** Context for enablement and runs (default: the registry's). */
	context?: TContext | (() => TContext);
	/** Only global commands plus these scopes. */
	scope?: string | readonly string[] | (() => string | readonly string[] | undefined);
	/** Initial recently run ids (newest first), e.g. restored from storage. */
	recents?: readonly string[];
	/** Called whenever the recents change, e.g. to persist them. */
	onRecentsChange?: (recents: string[]) => void;
	recentLimit?: number;
	/** Maximum rows (default 50). */
	limit?: number;
	/** Platform for shortcut display (default: detected). */
	platform?: Platform;
	/** Called after a command ran from the palette. */
	onRun?: (result: CommandResult) => void;
}

/**
 * Framework-agnostic command palette state (open, query, ranked rows, active row and
 * recents) over a `CommandRegistry`. The React hook and Svelte rune wrap it.
 */
export function createCommandPaletteController<TContext = any>(
	registry: CommandRegistry<TContext>,
	options: CommandPaletteOptions<TContext> = {}
) {
	const listeners = new Set<(state: CommandPaletteState) => void>();
	let open = false;
	let query = '';
	let activeIndex = 0;
	let recents = [...(options.recents ?? [])];
	let lastResult: CommandResult | null = null;
	let state: CommandPaletteState;

	const context = (): TContext => {
		const c = options.context;
		if (c === undefined) return registry.context;
		return (typeof c === 'function' ? (c as () => TContext)() : c) as TContext;
	};
	const scope = () => (typeof options.scope === 'function' ? options.scope() : options.scope);

	function computeItems(): CommandPaletteItem[] {
		if (!open) return [];
		const entries = registry.list({ scope: scope(), context: context() });
		const platform = options.platform ?? registry.shortcuts.platform;
		return rankCommands(query, entries, {
			recents,
			recentLimit: options.recentLimit,
			limit: options.limit ?? 50
		}).map((ranked) => ({
			...ranked,
			id: ranked.entry.id,
			label: ranked.entry.label,
			...(ranked.entry.group !== undefined ? { group: ranked.entry.group } : {}),
			...(ranked.entry.shortcuts[0] ? { shortcut: formatShortcut(ranked.entry.shortcuts[0], platform) } : {}),
			enabled: ranked.entry.enabled,
			...(ranked.entry.disabledReason ? { disabledReason: ranked.entry.disabledReason } : {})
		}));
	}

	function update() {
		const items = computeItems();
		activeIndex = items.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), items.length - 1);
		state = { open, query, activeIndex, items, recents, lastResult };
		for (const listener of Array.from(listeners)) listener(state);
	}

	state = { open, query, activeIndex, items: [], recents, lastResult };
	// Follow registry changes only while someone listens (safe with React StrictMode remounts).
	let unsubscribeRegistry: (() => void) | null = null;
	const onRegistryChange = () => {
		if (open) update();
	};

	const controller = {
		getState: () => state,
		subscribe(listener: (state: CommandPaletteState) => void): () => void {
			listeners.add(listener);
			unsubscribeRegistry ??= registry.subscribe(onRegistryChange);
			if (open) update(); // catch up with changes made while nobody listened
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					unsubscribeRegistry?.();
					unsubscribeRegistry = null;
				}
			};
		},
		setOpen(next: boolean) {
			if (next === open) return;
			open = next;
			query = '';
			activeIndex = 0;
			update();
		},
		toggle() {
			controller.setOpen(!open);
		},
		setQuery(next: string) {
			if (next === query) return;
			query = next;
			activeIndex = 0;
			update();
		},
		setActiveIndex(index: number) {
			activeIndex = index;
			update();
		},
		/** Moves the active row by `delta`, wrapping around. */
		move(delta: number) {
			const n = state.items.length;
			if (n === 0) return;
			activeIndex = (((activeIndex + delta) % n) + n) % n;
			update();
		},
		/** Runs a command by id, closes the palette and records it as recent. Disabled commands do nothing. */
		run(id: string): CommandResult | null {
			if (!registry.isEnabled(id, undefined, context()).enabled) return null;
			open = false;
			query = '';
			activeIndex = 0;
			recents = pushRecent(recents, id, options.recentLimit ?? DEFAULT_RECENT_LIMIT);
			options.onRecentsChange?.(recents);
			const result = registry.execute(id, undefined, context());
			lastResult = result;
			update();
			options.onRun?.(result);
			return result;
		},
		runActive(): CommandResult | null {
			const item = state.items[state.activeIndex];
			return item ? controller.run(item.id) : null;
		},
		/**
		 * Keyboard handling for the palette input: ArrowUp/ArrowDown (wrap), Home/End,
		 * Enter (run the active row) and Escape (close). Returns whether it handled the key.
		 */
		handleKeyDown(event: KeyboardEventLike): boolean {
			if (!open) return false;
			switch (event.key) {
				case 'ArrowDown':
					controller.move(1);
					break;
				case 'ArrowUp':
					controller.move(-1);
					break;
				case 'Home':
					controller.setActiveIndex(0);
					break;
				case 'End':
					controller.setActiveIndex(state.items.length - 1);
					break;
				case 'Enter':
					controller.runActive();
					break;
				case 'Escape':
					controller.setOpen(false);
					break;
				default:
					return false;
			}
			event.preventDefault?.();
			return true;
		},
		/** Re-reads commands and enablement. */
		refresh() {
			update();
		},
		destroy() {
			unsubscribeRegistry?.();
			unsubscribeRegistry = null;
			listeners.clear();
		}
	};
	return controller;
}

export type CommandPaletteController = ReturnType<typeof createCommandPaletteController>;

/**
 * Matches a global "open palette" hotkey (e.g. `Mod+K`), also while typing in inputs.
 * Returns `true` when `event` is the hotkey.
 */
export function matchPaletteHotkey(event: KeyboardEventLike, hotkey: string, platform?: Platform): boolean {
	const map = new ShortcutMap([{ command: 'palette', chord: hotkey, allowInEditable: true }], platform ? { platform } : {});
	return map.resolve(event) !== null;
}
