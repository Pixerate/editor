// Portions ported from filmcraft-main/crates/engine/src/shortcuts_tests.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, vi } from 'vitest';
import {
	CommandRegistry,
	CommandRegistryError,
	ShortcutMap,
	createCommandRegistry,
	createCommandPaletteController,
	createArrangeCommands,
	createHistoryCommands,
	createSpreadsheetCommands,
	DEFAULT_HISTORY_SHORTCUTS,
	effectiveChordKey,
	exactBonus,
	formatShortcut,
	fuzzyMatch,
	fuzzyScore,
	matchHistoryShortcut,
	matchPaletteHotkey,
	normalizeChord,
	parseChord,
	pushRecent,
	rankCommands,
	PLATFORMS,
	type CommandSpec
} from '../src/commands';
import { HistoryManager } from '../src/history';
import { createCanvasArrangeController, DEFAULT_ARRANGE_SHORTCUTS, type CanvasNode } from '../src/canvas';
import { SpreadsheetController } from '../src/spreadsheet';

type KeyInit = {
	key?: string;
	code?: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	target?: unknown;
};
const key = (init: KeyInit) => {
	const event = {
		key: '',
		code: '',
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		target: null as unknown,
		defaultPrevented: false,
		preventDefault: vi.fn(() => {
			event.defaultPrevented = true;
		}),
		...init
	};
	return event;
};
const input = { tagName: 'INPUT', isContentEditable: false, closest: () => null };

describe('chords', () => {
	it('parses, normalises and formats per platform', () => {
		expect(parseChord('Mod+Shift+Z')).toEqual({ key: 'KeyZ', mod: true, shift: true });
		expect(normalizeChord('shift+cmdorctrl+z')).toBe('Mod+Shift+Z');
		expect(normalizeChord('⌥⇧⌘K')).toBe('Meta+Alt+Shift+K');
		expect(normalizeChord('Alt+]')).toBe('Alt+]');
		expect(parseChord('Mod+]').key).toBe('BracketRight');
		expect(parseChord('PageDown').key).toBe('PageDown');
		expect(parseChord('Ctrl+Up').key).toBe('ArrowUp');
		expect(parseChord('F5').key).toBe('F5');
		expect(parseChord('Mod+Plus').key).toBe('Equal');
		expect(formatShortcut('Mod+Shift+Z', 'mac')).toBe('⇧⌘Z');
		expect(formatShortcut('Mod+Shift+Z', 'windows')).toBe('Ctrl+Shift+Z');
		expect(formatShortcut('Mod+Alt+[', 'linux')).toBe('Ctrl+Alt+[');
		expect(formatShortcut('Ctrl+Alt+K', 'mac')).toBe('⌃⌥K');
		expect(formatShortcut('Meta+K', 'windows')).toBe('Win+K');
		expect(formatShortcut('Meta+K', 'linux')).toBe('Super+K');
		expect(formatShortcut('Backspace', 'mac')).toBe('⌫');
		expect(formatShortcut('PageDown', 'windows')).toBe('Page Down');
		expect(formatShortcut('not a chord+', 'mac')).toBe('not a chord+');
	});

	it('rejects unknown modifiers and keys', () => {
		expect(() => parseChord('')).toThrow(/Empty/);
		expect(() => parseChord('Hyper+K')).toThrow(/modifier/);
		expect(() => parseChord('Mod+Banana')).toThrow(/key/);
		expect(() => parseChord('Mod+')).toThrow(/no key/);
	});

	it('resolves Mod to Command on macOS and Ctrl elsewhere', () => {
		expect(effectiveChordKey('Mod+Y', 'mac')).toBe('Meta+KeyY');
		expect(effectiveChordKey('Mod+Y', 'windows')).toBe('Ctrl+KeyY');
		expect(effectiveChordKey('Ctrl+Y', 'windows')).toBe('Ctrl+KeyY');
		expect(effectiveChordKey('Ctrl+Y', 'mac')).toBe('Ctrl+KeyY');
	});
});

describe('ShortcutMap', () => {
	it('matches event.code with platform-specific Mod', () => {
		const map = new ShortcutMap([{ command: 'undo', chord: 'Mod+Z' }], { platform: 'mac' });
		expect(map.resolve(key({ code: 'KeyZ', metaKey: true }))?.command).toBe('undo');
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true }))).toBeNull();
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true }), { platform: 'windows' })?.command).toBe('undo');
		expect(map.resolve(key({ code: 'KeyZ', metaKey: true, shiftKey: true }))).toBeNull();
		// Synthetic events without a code fall back to the key.
		expect(map.resolve(key({ key: 'z', metaKey: true }))?.command).toBe('undo');
	});

	it('matches Option chords on macOS by code and follows Latin layouts for letters', () => {
		const map = new ShortcutMap(
			[
				{ command: 'alignLeft', chord: 'Alt+A' },
				{ command: 'undo', chord: 'Mod+Z' }
			],
			{ platform: 'windows' }
		);
		expect(map.resolve(key({ code: 'KeyA', key: 'å', altKey: true }))?.command).toBe('alignLeft');
		// AZERTY: the key labelled Z sits at KeyW, and KeyZ produces "w".
		expect(map.resolve(key({ code: 'KeyW', key: 'z', ctrlKey: true }))?.command).toBe('undo');
		expect(map.resolve(key({ code: 'KeyZ', key: 'w', ctrlKey: true }))).toBeNull();
		// Non-Latin layouts and punctuation use the physical key.
		expect(map.resolve(key({ code: 'KeyZ', key: 'я', ctrlKey: true }))?.command).toBe('undo');
	});

	it('supports a lenient mode where Mod matches Command or Ctrl', () => {
		const map = new ShortcutMap([{ command: 'lock', chord: 'Mod+L' }], { modifierMode: 'either', platform: 'mac' });
		expect(map.resolve(key({ code: 'KeyL', ctrlKey: true }))?.command).toBe('lock');
		expect(map.resolve(key({ code: 'KeyL', metaKey: true }))?.command).toBe('lock');
		expect(map.resolve(key({ code: 'KeyL' }))).toBeNull();
	});

	it('prefers scoped bindings and ignores other scopes', () => {
		const map = new ShortcutMap(
			[
				{ command: 'global.delete', chord: 'Delete' },
				{ command: 'canvas.delete', chord: 'Delete', scope: 'canvas' },
				{ command: 'sheet.delete', chord: 'Delete', scope: 'sheet' },
				{ command: 'sheet.only', chord: 'Mod+E', scope: 'sheet' }
			],
			{ platform: 'linux' }
		);
		expect(map.resolve(key({ code: 'Delete' }))?.command).toBe('global.delete');
		expect(map.resolve(key({ code: 'Delete' }), { scopes: 'canvas' })?.command).toBe('canvas.delete');
		expect(map.resolve(key({ code: 'Delete' }), { scopes: ['sheet', 'canvas'] })?.command).toBe('sheet.delete');
		expect(map.resolve(key({ code: 'KeyE', ctrlKey: true }), { scopes: 'canvas' })).toBeNull();
		expect(map.findConflicts('linux')).toEqual([]);
	});

	it('ignores events from text inputs unless allowed', () => {
		const map = new ShortcutMap(
			[
				{ command: 'undo', chord: 'Mod+Z' },
				{ command: 'palette', chord: 'Mod+K', allowInEditable: true }
			],
			{ platform: 'linux' }
		);
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true, target: input }))).toBeNull();
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true, target: input }), { allowInEditable: true })?.command).toBe('undo');
		expect(map.resolve(key({ code: 'KeyK', ctrlKey: true, target: input }))?.command).toBe('palette');
		const editableChild = { tagName: 'SPAN', closest: (s: string) => (s === '.ProseMirror' ? {} : null) };
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true, target: editableChild }))).toBeNull();
	});

	it('limits bindings to platforms and reports conflicts per platform', () => {
		const map = new ShortcutMap([
			{ command: 'redo', chord: 'Mod+Y' },
			{ command: 'other', chord: 'Ctrl+Y' }
		]);
		expect(map.findConflicts('mac')).toEqual([]);
		expect(map.findConflicts('windows')).toEqual([{ chord: 'Ctrl+KeyY', commands: ['redo', 'other'] }]);
		expect(Object.keys(map.findAllConflicts())).toEqual(['windows', 'linux']);

		const history = new ShortcutMap(DEFAULT_HISTORY_SHORTCUTS);
		expect(history.forCommand('redo', 'mac')).toEqual(['Mod+Shift+Z']);
		expect(history.forCommand('redo', 'windows')).toEqual(['Mod+Shift+Z', 'Mod+Y']);
	});

	it('applies, clears and persists user overrides', () => {
		const map = new ShortcutMap([{ command: 'undo', chord: 'Mod+Z' }], { platform: 'linux' });
		const changed = vi.fn();
		map.subscribe(changed);
		map.setOverride('undo', ['Alt+Backspace']);
		expect(map.resolve(key({ code: 'KeyZ', ctrlKey: true }))).toBeNull();
		expect(map.resolve(key({ code: 'Backspace', altKey: true }))?.command).toBe('undo');
		expect(map.getOverrides()).toEqual({ undo: ['Alt+Backspace'] });
		map.setOverride('undo', []);
		expect(map.forCommand('undo')).toEqual([]);
		map.clearOverride('undo');
		expect(map.forCommand('undo')).toEqual(['Mod+Z']);
		map.setOverrides({ undo: ['Mod+U'] });
		expect(map.forCommand('undo')).toEqual(['Mod+U']);
		expect(changed).toHaveBeenCalledTimes(4);
		expect(() => map.setOverride('undo', 'Hyper+U')).toThrow();
	});

	it('bind returns a remover', () => {
		const map = new ShortcutMap([], { platform: 'linux' });
		const remove = map.bind({ command: 'a', chord: 'Mod+A' });
		expect(map.forCommand('a')).toEqual(['Mod+A']);
		remove();
		expect(map.forCommand('a')).toEqual([]);
	});
});

describe('default keymaps', () => {
	const registry = () => {
		const r = new CommandRegistry();
		r.register(createHistoryCommands(new HistoryManager()));
		r.register(
			createArrangeCommands(
				{ align: vi.fn(), distribute: vi.fn(), reorder: vi.fn(), lock: vi.fn(), unlock: vi.fn() },
				{ scenes: { next: vi.fn(), previous: vi.fn() } }
			)
		);
		r.register(
			createSpreadsheetCommands({
				selectedRange: null,
				getFilterState: () => ({ enabled: false, rules: [] }),
				toggleFilters: vi.fn(),
				clearFilters: vi.fn(),
				unhideAll: vi.fn(),
				mergeCells: () => true,
				unmergeCells: () => true,
				transposeRange: () => true
			})
		);
		return r;
	};

	it('default keymaps have no conflicts on any platform', () => {
		const r = registry();
		for (const platform of PLATFORMS) {
			expect(r.shortcuts.findConflicts(platform), platform).toEqual([]);
		}
		expect(new ShortcutMap(DEFAULT_HISTORY_SHORTCUTS).findAllConflicts()).toEqual({});
	});

	it('the arrange bindings are conflict-free even when Mod matches Command or Ctrl', () => {
		const map = new ShortcutMap(
			DEFAULT_ARRANGE_SHORTCUTS.map((b) => ({ command: b.action, chord: b.label })),
			{ modifierMode: 'either' }
		);
		expect(map.findAllConflicts()).toEqual({});
	});
});

describe('CommandRegistry', () => {
	const setup = () => {
		const registry = createCommandRegistry<{ count: number }>({ context: { count: 0 } });
		const run = vi.fn((ctx: { count: number }, params: { by?: number }) => (ctx.count += params.by ?? 1));
		registry.register({
			id: 'counter.add',
			label: 'Add',
			group: 'Counter',
			shortcut: 'Mod+Shift+A',
			params: { type: 'object', properties: { by: { type: 'integer', minimum: 1 } } },
			run
		});
		registry.register({
			id: 'counter.reset',
			label: 'Reset',
			enabled: (ctx) => (ctx.count > 0 ? true : 'Already at zero.'),
			run: (ctx) => {
				ctx.count = 0;
			}
		});
		return { registry, run };
	};

	it('rejects duplicate ids, bad ids and invalid shortcuts without registering anything', () => {
		const { registry } = setup();
		expect(() => registry.register({ id: 'counter.add', label: 'x', run: () => {} })).toThrow(CommandRegistryError);
		expect(() => registry.register({ id: 'bad id', label: 'x', run: () => {} })).toThrow(/Invalid command id/);
		expect(() =>
			registry.register([
				{ id: 'ok.one', label: 'One', run: () => {} },
				{ id: 'ok.two', label: 'Two', shortcut: 'Hyper+K', run: () => {} }
			])
		).toThrow(/Unknown modifier/);
		expect(registry.has('ok.one')).toBe(false);
		expect(registry.ids()).toEqual(['counter.add', 'counter.reset']);
	});

	it('executes with structured results', () => {
		const { registry, run } = setup();
		expect(registry.execute('counter.add', { by: 2 })).toEqual({ ok: true, id: 'counter.add', result: 2 });
		expect(registry.execute('nope')).toMatchObject({ ok: false, code: 'unknown_command', message: 'Unknown command "nope".' });
		expect(registry.execute('counter.add', { step: 1 })).toEqual({
			ok: false,
			id: 'counter.add',
			code: 'invalid_params',
			message: 'Unknown parameter "step" for command "counter.add"; expected "by".'
		});
		expect(registry.execute('counter.reset', { hard: true })).toMatchObject({
			code: 'invalid_params',
			message: expect.stringContaining('expected no parameters')
		});
		expect(registry.execute('counter.add', { by: 0 })).toMatchObject({ code: 'invalid_params', details: [{ path: '/by' }] });
		expect(registry.execute('counter.add', [1])).toMatchObject({ code: 'invalid_params' });
		expect(run).toHaveBeenCalledTimes(1);
		expect(registry.execute('counter.reset')).toMatchObject({ ok: true });
		expect(registry.execute('counter.reset')).toEqual({
			ok: false,
			id: 'counter.reset',
			code: 'disabled',
			message: 'Already at zero.'
		});
		registry.register({ id: 'boom', label: 'Boom', run: () => { throw new Error('kaput'); } });
		expect(registry.execute('boom')).toEqual({ ok: false, id: 'boom', code: 'failed', message: 'kaput' });
	});

	it('re-checks enablement against targets named in params', () => {
		const registry = new CommandRegistry<{ selection: string[] }>({ context: { selection: [] } });
		registry.register({
			id: 'nodes.delete',
			label: 'Delete',
			params: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
			enabled: (ctx, params?: { ids?: string[] }) =>
				(params?.ids ?? ctx.selection).length > 0 ? true : 'No nodes selected.',
			run: (ctx, params: { ids?: string[] }) => params.ids ?? ctx.selection
		});
		expect(registry.list()[0]).toMatchObject({ enabled: false, disabledReason: 'No nodes selected.' });
		expect(registry.execute('nodes.delete')).toMatchObject({ code: 'disabled' });
		expect(registry.execute('nodes.delete', { ids: ['a'] })).toEqual({ ok: true, id: 'nodes.delete', result: ['a'] });
	});

	it('lists commands with enablement, shortcuts and scopes', () => {
		const { registry } = setup();
		registry.register({ id: 'canvas.thing', label: 'Thing', scope: 'canvas', run: () => {} });
		registry.register({ id: 'secret', label: 'Secret', hidden: true, run: () => {} });
		const list = registry.list();
		expect(list.map((e) => e.id)).toEqual(['counter.add', 'counter.reset', 'canvas.thing']);
		expect(list[0]).toMatchObject({ group: 'Counter', shortcuts: ['Mod+Shift+A'], enabled: true, undoable: false });
		expect(list[1]).toMatchObject({ enabled: false, disabledReason: 'Already at zero.' });
		expect(registry.list({ enabledOnly: true }).map((e) => e.id)).toEqual(['counter.add', 'canvas.thing']);
		expect(registry.list({ scope: 'sheet' }).map((e) => e.id)).toEqual(['counter.add', 'counter.reset']);
		expect(registry.list({ includeHidden: true })).toHaveLength(4);
		expect(registry.list({ context: { count: 3 } })[1].enabled).toBe(true);
	});

	it('notifies subscribers and unregisters', () => {
		const { registry } = setup();
		const listener = vi.fn();
		registry.subscribe(listener);
		const remove = registry.register({ id: 'x', label: 'X', shortcut: 'Mod+X', run: () => {} });
		expect(listener).toHaveBeenCalledTimes(1);
		remove();
		remove();
		expect(registry.has('x')).toBe(false);
		expect(registry.shortcuts.forCommand('x')).toEqual([]);
		expect(listener).toHaveBeenCalledTimes(2);
		registry.invalidate();
		expect(listener).toHaveBeenCalledTimes(3);
		expect(registry.unregister('counter.add')).toBe(true);
		expect(registry.unregister('counter.add')).toBe(false);
	});

	it('runs undoable commands as one history step and rolls back failures', () => {
		const history = new HistoryManager();
		let value = 0;
		const step = (to: number) => {
			const from = value;
			history.execute({ name: 'set', execute: () => (value = to), undo: () => (value = from) });
		};
		const registry = new CommandRegistry({ history });
		registry.register([
			{ id: 'twice', label: 'Twice', undoable: true, run: () => { step(1); step(2); } },
			{ id: 'broken', label: 'Broken', undoable: true, run: () => { step(10); throw new Error('half done'); } }
		]);
		expect(registry.execute('twice')).toMatchObject({ ok: true });
		expect(value).toBe(2);
		expect(history.getState()).toMatchObject({ undoCount: 1, undoName: 'Twice' });
		expect(registry.execute('broken')).toMatchObject({ ok: false, code: 'failed', message: 'half done' });
		expect(value).toBe(2);
		expect(history.getState().undoCount).toBe(1);
		history.undo();
		expect(value).toBe(0);
	});

	it('awaits async commands in executeAsync', async () => {
		const registry = new CommandRegistry();
		registry.register([
			{ id: 'later', label: 'Later', run: async () => 42 },
			{ id: 'reject', label: 'Reject', run: async () => { throw new Error('nope'); } }
		]);
		expect(await registry.executeAsync('later')).toEqual({ ok: true, id: 'later', result: 42 });
		expect(await registry.executeAsync('reject')).toMatchObject({ ok: false, code: 'failed', message: 'nope' });
		expect(await registry.executeAsync('missing')).toMatchObject({ code: 'unknown_command' });
	});

	it('handles keydown events, leaving disabled commands to the browser', () => {
		const { registry } = setup();
		const registryShortcuts = new CommandRegistry<{ count: number }>({
			context: { count: 0 },
			shortcuts: { platform: 'linux' }
		});
		registryShortcuts.register(registry.get('counter.add')!);
		registryShortcuts.register({ ...registry.get('counter.reset')!, shortcut: 'Mod+R' });
		const add = key({ code: 'KeyA', ctrlKey: true, shiftKey: true });
		expect(registryShortcuts.handleKeyDown(add)).toMatchObject({ ok: true, result: 1 });
		expect(add.preventDefault).toHaveBeenCalled();
		expect(registryShortcuts.handleKeyDown(add)).toBeNull(); // already handled
		const reset = key({ code: 'KeyR', ctrlKey: true });
		expect(registryShortcuts.handleKeyDown(reset, { context: { count: 0 } })).toBeNull();
		expect(reset.preventDefault).not.toHaveBeenCalled();
		expect(registryShortcuts.handleKeyDown(key({ code: 'KeyA', ctrlKey: true, shiftKey: true, target: input }))).toBeNull();
	});
});

describe('palette ranking', () => {
	it('scores subsequences with consecutive and word-start bonuses', () => {
		expect(fuzzyScore('', 'Anything')).toBe(0);
		expect(fuzzyScore('xyz', 'Align Left')).toBeNull();
		expect(fuzzyMatch('al', 'Align Left')?.indices).toEqual([0, 1]);
		// "al" at a word start and consecutive beats scattered letters.
		expect(fuzzyScore('al', 'Align Left')!).toBeGreaterThan(fuzzyScore('al', 'Normal')!);
		expect(fuzzyScore('bf', 'Bring Forward')!).toBeGreaterThan(fuzzyScore('bf', 'Bring Toolbar Forward Later On Please')!);
		expect(exactBonus('settings', ['Settings…'])).toBe(1000);
		expect(exactBonus('settings', ['Color Settings'])).toBe(0);
	});

	it('keeps recents deduplicated, newest first and capped', () => {
		let list: string[] = [];
		list = pushRecent(list, 'b', 3);
		list = pushRecent(list, 'a', 3);
		list = pushRecent(list, 'c', 3);
		expect(list).toEqual(['c', 'a', 'b']);
		list = pushRecent(list, 'a', 3);
		expect(list).toEqual(['a', 'c', 'b']);
		expect(pushRecent(list, 'd', 3)).toEqual(['d', 'a', 'c']);
	});

	const entries = [
		{ id: 'view.settings', label: 'Color Settings', group: 'View' },
		{ id: 'app.settings', label: 'Settings', group: 'App' },
		{ id: 'canvas.alignLeft', label: 'Align Left', group: 'Arrange', keywords: ['flush'] },
		{ id: 'history.undo', label: 'Undo', group: 'Edit', enabled: false },
		{ id: 'history.redo', label: 'Redo', group: 'Edit' }
	];

	it('ranks exact labels first and searches group, keywords and id', () => {
		expect(rankCommands('settings', entries).map((r) => r.entry.id)).toEqual(['app.settings', 'view.settings']);
		expect(rankCommands('flush', entries)[0].entry.id).toBe('canvas.alignLeft');
		expect(rankCommands('arrange left', entries)[0].entry.id).toBe('canvas.alignLeft');
		expect(rankCommands('history', entries).map((r) => r.entry.id)).toEqual(['history.redo', 'history.undo']);
		expect(rankCommands('do', entries, { disabledLast: false })[0].entry.id).toBe('history.undo');
		expect(rankCommands('zzz', entries)).toEqual([]);
		expect(rankCommands('al', entries)[0].labelIndices).toEqual([0, 1]);
	});

	it('shows recents first for an empty query', () => {
		const ranked = rankCommands('', entries, { recents: ['history.redo', 'missing', 'history.redo', 'app.settings'] });
		expect(ranked.map((r) => [r.entry.id, r.recent])).toEqual([
			['history.redo', true],
			['app.settings', true],
			['view.settings', false],
			['canvas.alignLeft', false],
			['history.undo', false]
		]);
		expect(rankCommands('', entries, { recents: ['history.redo', 'app.settings'], recentLimit: 1, emptyQuery: 'recents' }).map((r) => r.entry.id)).toEqual(['history.redo']);
		expect(rankCommands('', entries, { limit: 2 })).toHaveLength(2);
	});
});

describe('command palette controller', () => {
	it('opens, filters, navigates, runs and remembers recents', () => {
		const registry = new CommandRegistry({ shortcuts: { platform: 'mac' } });
		const history = new HistoryManager();
		registry.register(createHistoryCommands(history));
		const runA = vi.fn();
		registry.register([
			{ id: 'a', label: 'Alpha', shortcut: 'Mod+Shift+A', run: runA },
			{ id: 'b', label: 'Beta', run: () => {} }
		]);
		const onRecentsChange = vi.fn();
		const palette = createCommandPaletteController(registry, { onRecentsChange });
		const states: boolean[] = [];
		palette.subscribe((s) => states.push(s.open));
		expect(palette.getState().items).toEqual([]);
		palette.setOpen(true);
		const items = palette.getState().items;
		// Disabled commands sort last.
		expect(items.map((i) => i.id)).toEqual(['a', 'b', 'history.undo', 'history.redo']);
		const undo = items.find((i) => i.id === 'history.undo')!;
		expect(undo).toMatchObject({ enabled: false, disabledReason: 'Nothing to undo.', shortcut: '⌘Z' });
		expect(items.find((i) => i.id === 'a')?.shortcut).toBe('⇧⌘A');

		palette.setQuery('alp');
		expect(palette.getState().items.map((i) => i.id)).toEqual(['a']);
		palette.setQuery('');
		palette.move(-1);
		expect(palette.getState().activeIndex).toBe(palette.getState().items.length - 1);
		palette.move(1);
		expect(palette.getState().activeIndex).toBe(0);
		expect(palette.run('history.undo')).toBeNull(); // disabled: stays open
		expect(palette.getState().open).toBe(true);
		const enter = key({ key: 'Enter' });
		expect(palette.handleKeyDown(enter)).toBe(true);
		expect(enter.preventDefault).toHaveBeenCalled();
		expect(runA).toHaveBeenCalledTimes(1);
		expect(palette.getState()).toMatchObject({ open: false, recents: ['a'], lastResult: { ok: true, id: 'a' } });
		expect(onRecentsChange).toHaveBeenCalledWith(['a']);

		palette.toggle();
		palette.setQuery('beta');
		palette.handleKeyDown(key({ key: 'Enter' }));
		palette.setOpen(true);
		expect(palette.getState().items.slice(0, 2).map((i) => [i.id, i.recent])).toEqual([
			['b', true],
			['a', true]
		]);
		expect(palette.handleKeyDown(key({ key: 'x' }))).toBe(false);
		palette.handleKeyDown(key({ key: 'Escape' }));
		expect(palette.getState().open).toBe(false);
		expect(palette.handleKeyDown(key({ key: 'ArrowDown' }))).toBe(false);
		palette.destroy();
	});

	it('refreshes enablement while open and matches the hotkey in inputs', () => {
		const registry = new CommandRegistry();
		const history = new HistoryManager();
		registry.register(createHistoryCommands(history));
		const palette = createCommandPaletteController(registry, { scope: () => undefined });
		const stop = palette.subscribe(() => {});
		palette.setOpen(true);
		expect(palette.getState().items.find((i) => i.id === 'history.undo')?.enabled).toBe(false);
		history.execute({ name: 'x', execute: () => {}, undo: () => {} });
		registry.invalidate();
		expect(palette.getState().items.find((i) => i.id === 'history.undo')?.enabled).toBe(true);
		// Without listeners the palette stops following the registry.
		stop();
		history.undo();
		registry.invalidate();
		expect(palette.getState().items.find((i) => i.id === 'history.undo')?.enabled).toBe(true);
		palette.subscribe(() => {});
		expect(palette.getState().items.find((i) => i.id === 'history.undo')?.enabled).toBe(false);
		expect(matchPaletteHotkey(key({ code: 'KeyK', metaKey: true, target: input }), 'Mod+K', 'mac')).toBe(true);
		expect(matchPaletteHotkey(key({ code: 'KeyK', ctrlKey: true }), 'Mod+K', 'mac')).toBe(false);
	});
});

describe('built-in commands', () => {
	it('history commands undo and redo with reasons when empty', () => {
		const history = new HistoryManager();
		const registry = new CommandRegistry({ shortcuts: { platform: 'windows' } });
		registry.register(createHistoryCommands(history));
		expect(registry.execute('history.undo')).toMatchObject({ code: 'disabled', message: 'Nothing to undo.' });
		let value = 0;
		history.execute({ name: 'inc', execute: () => value++, undo: () => value-- });
		expect(registry.execute('history.undo')).toMatchObject({ ok: true });
		expect(value).toBe(0);
		expect(registry.handleKeyDown(key({ code: 'KeyY', ctrlKey: true }))).toMatchObject({ ok: true, id: 'history.redo' });
		expect(value).toBe(1);
		expect(registry.shortcuts.forCommand('history.redo')).toEqual(['Mod+Shift+Z', 'Mod+Y']);
		expect(registry.shortcuts.forCommand('history.redo', 'mac')).toEqual(['Mod+Shift+Z']);
	});

	it('matchHistoryShortcut follows the platform and skips inputs', () => {
		expect(matchHistoryShortcut(key({ key: 'z', metaKey: true }), { platform: 'mac' })).toBe('undo');
		expect(matchHistoryShortcut(key({ key: 'z', ctrlKey: true }), { platform: 'mac' })).toBeNull();
		expect(matchHistoryShortcut(key({ key: 'z', ctrlKey: true, shiftKey: true }), { platform: 'linux' })).toBe('redo');
		expect(matchHistoryShortcut(key({ key: 'y', ctrlKey: true }), { platform: 'windows' })).toBe('redo');
		expect(matchHistoryShortcut(key({ key: 'y', metaKey: true }), { platform: 'mac' })).toBeNull();
		expect(matchHistoryShortcut(key({ key: 'z', ctrlKey: true, target: input }), { platform: 'linux' })).toBeNull();
		expect(matchHistoryShortcut(key({ key: 'z', ctrlKey: true, target: input }), { platform: 'linux', allowInEditable: true })).toBe('undo');
	});

	it('arrange commands drive the controller and check the selection or named ids', () => {
		let nodes: CanvasNode[] = [
			{ id: 'a', position: { x: 0, y: 0 }, width: 100, height: 50, selected: true } as CanvasNode,
			{ id: 'b', position: { x: 40, y: 100 }, width: 100, height: 50 } as CanvasNode
		];
		const history = new HistoryManager();
		const controller = createCanvasArrangeController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), history });
		const registry = new CommandRegistry({ shortcuts: { platform: 'mac' } });
		const next = vi.fn();
		registry.register(
			createArrangeCommands(controller, {
				getSelectedIds: () => nodes.filter((n) => n.selected).map((n) => n.id),
				scenes: { next, previous: vi.fn() }
			})
		);
		expect(registry.execute('canvas.alignRight')).toMatchObject({ code: 'disabled', message: 'Select at least 2 nodes.' });
		expect(registry.execute('canvas.alignRight', { ids: ['a', 'b'] })).toMatchObject({ ok: true });
		expect(nodes.find((n) => n.id === 'a')!.position.x).toBe(40);
		expect(registry.list().find((e) => e.id === 'canvas.lock')).toMatchObject({ enabled: true, shortcuts: ['Mod+L'], scope: 'canvas' });
		// Shortcuts are scoped to the canvas.
		expect(registry.handleKeyDown(key({ code: 'KeyL', metaKey: true }))).toBeNull();
		expect(registry.handleKeyDown(key({ code: 'KeyL', metaKey: true }), { scopes: 'canvas' })).toMatchObject({ id: 'canvas.lock' });
		expect(controller.isLocked('a')).toBe(true);
		registry.handleKeyDown(key({ code: 'PageDown' }), { scopes: 'canvas' });
		expect(next).toHaveBeenCalled();
		expect(registry.execute('canvas.alignLeft', { ids: ['a'], extra: 1 })).toMatchObject({
			code: 'invalid_params',
			message: 'Unknown parameter "extra" for command "canvas.alignLeft"; expected "ids".'
		});
		expect(createArrangeCommands(controller).some((c) => c.id === 'canvas.nextScene')).toBe(false);
		expect(createArrangeCommands(controller, { scope: null, prefix: 'a/' })[0]).toMatchObject({ id: 'a/alignLeft' });
		expect(createArrangeCommands(controller, { scope: null })[0].scope).toBeUndefined();
	});

	it('spreadsheet commands run table actions', () => {
		const ctrl = new SpreadsheetController({
			document: {
				columns: [0, 1].map((i) => ({ id: `c${i}`, key: `C${i}`, title: `C${i}`, type: 'freeform' as const })),
				rows: [0, 1].map((i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
			}
		});
		const registry = new CommandRegistry();
		registry.register(createSpreadsheetCommands(ctrl));
		expect(registry.execute('spreadsheet.mergeCells')).toMatchObject({ code: 'disabled', message: 'Select a range first.' });
		expect(registry.execute('spreadsheet.clearFilters')).toMatchObject({ code: 'disabled' });
		expect(registry.execute('spreadsheet.toggleFilters')).toMatchObject({ ok: true });
		expect(ctrl.getFilterState().enabled).toBe(true);
		ctrl.selectRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
		expect(registry.execute('spreadsheet.mergeCells')).toEqual({ ok: true, id: 'spreadsheet.mergeCells', result: true });
		expect(ctrl.getMerges()).toHaveLength(1);
		// Nothing to do is a failure, not a silent `false`.
		ctrl.selectRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
		expect(registry.execute('spreadsheet.mergeCells')).toMatchObject({ ok: false, message: expect.stringMatching(/Cannot merge the selection/) });
		ctrl.selectRange({ startRow: 5, startCol: 5, endRow: 6, endCol: 6 });
		expect(registry.execute('spreadsheet.unmergeCells')).toMatchObject({ ok: false, message: 'There are no merged cells in the selection.' });
	});
});

describe('command spec typing', () => {
	it('accepts plain spec objects', () => {
		const spec: CommandSpec = { id: 'x', label: 'X', run: () => 1 };
		expect(new CommandRegistry().register(spec)).toBeTypeOf('function');
	});
});
