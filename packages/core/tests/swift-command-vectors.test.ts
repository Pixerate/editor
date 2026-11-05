import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider, fuzzyMatch, exactBonus, rankCommands } from '../src/commands';
import { HistoryManager } from '../src/history';
import { ToolRegistry } from '../src/tools';

/**
 * Test vectors for the Swift command registry and its agent tools (`PixerateCore`'s
 * `CommandRegistry`, `createCommandToolProvider` and palette ranking): every tool result of a
 * scripted session, byte for byte, and the fuzzy ranking scores. A drift from the committed file
 * fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it, then rerun the Swift tests).
 * `CommandRegistryTests.swift` builds the same registry; keep the two `setup`s in step.
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateCoreTests/Fixtures/command-vectors.json');

// The result in the key order Swift's `McpToolResult.json` writes.
const norm = (r: any) => JSON.stringify({ content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) });

function setup(withHistory = true) {
	const history = new HistoryManager();
	const ctx = { value: 0 };
	const set = (to: number) => {
		const from = ctx.value;
		history.execute({ name: 'set', execute: () => (ctx.value = to), undo: () => (ctx.value = from) });
	};
	const commands = new CommandRegistry<{ value: number }>({ context: ctx, ...(withHistory ? { history } : {}), shortcuts: { platform: 'mac' } });
	commands.register([
		{ id: 'counter.set', label: 'Set Counter', group: 'Counter', keywords: ['assign'], shortcut: 'Mod+Shift+S', undoable: true,
		  params: { type: 'object', properties: { value: { type: 'integer', minimum: 0, description: 'New value.' } }, required: ['value'] },
		  run: (_c, p: any) => { set(p.value); return { value: ctx.value }; } },
		{ id: 'counter.add', label: 'Add…', group: 'Counter', description: 'Adds to the counter.', undoable: true,
		  params: { type: 'object', properties: { by: { type: 'number', description: 'Step.' } }, additionalProperties: false },
		  run: (_c, p: any) => { set(ctx.value + (p.by ?? 1)); return { value: ctx.value, items: [{ id: `i${ctx.value}` }] }; } },
		{ id: 'counter.reset', label: 'Reset', group: 'Counter', enabled: (c) => (c.value > 0 ? true : 'Already at zero.'), run: () => { set(0); } },
		{ id: 'counter.fail', label: 'Fail', undoable: true, run: () => { set(99); throw new Error('kaput'); } },
		{ id: 'counter.nan', label: 'Odd Numbers', readOnly: true, run: () => ({ x: NaN, y: -0, z: [Infinity, 1.5e-7] }) },
		{ id: 'counter.off', label: 'Off', enabled: () => false, run: () => 1 },
		{ id: 'counter.hidden', label: 'Hidden', hidden: true, run: () => 'secret' },
		{ id: 'canvas.thing', label: 'Thing', scope: 'canvas', shortcut: [{ chord: 'Mod+Y', platforms: ['windows', 'linux'] }, 'Alt+]', '⌥⇧⌘K'], run: () => 'thing' }
	]);
	const tools = new ToolRegistry();
	tools.register(createCommandToolProvider(commands, { tools: (id) => id.startsWith('counter.a') || id === 'counter.reset' || id === 'canvas.thing' || id === 'counter.nan' }));
	return { tools, history, ctx, commands };
}

async function vectors() {
	const out: Record<string, unknown> = {};
	const { tools, history, ctx } = setup();
	out.listTools = JSON.stringify(tools.listTools().tools);
	const calls: Array<[string, any]> = [
		['list_commands', {}],
		['list_commands', { query: 'counter' }],
		['list_commands', { query: 'add', enabledOnly: true }],
		['list_commands', { query: 'assign' }],
		['list_commands', { query: 'zzz' }],
		['run_command', { id: 'counter.set', params: { value: 5 } }],
		['run_command', { id: 'counter.set', params: { value: -1.5 } }],
		['run_command', { id: 'counter.set', params: { value: 1, extra: true } }],
		['run_command', { id: 'counter.reset', params: { hard: true } }],
		['run_command', { id: 'counter.add' }],
		['run_command', { id: 'counter.off' }],
		['run_command', { id: 'counter.nan' }],
		['run_command', { id: 'counter.fail' }],
		['run_command', { id: 'nope' }],
		['run_command', { id: 'counter.hidden' }],
		['run_commands', { steps: [
			{ id: 'counter.add', params: { by: 2 } },
			{ id: 'counter.set', params: { value: '$0.value' } },
			{ id: 'counter.add', params: { by: '$0.items.length' } },
			{ id: 'counter.add', params: { by: '$last.items[0]' } }
		] }],
		['run_commands', { stopOnError: false, steps: [
			{ id: 'counter.hidden' },
			{ id: 'counter.add', params: { by: '$5.id' } },
			{ id: 'counter.add', params: { by: '$last.value' } },
			{ id: 'counter.add', params: { by: '$2.nope' } },
			{ id: 'counter.add', params: { by: '$0007.x' } },
			{ id: 'counter.add', params: { by: '$2.items.0.id.length' } },
			{ id: 'counter.add', params: { note: ['$2.value', { deep: '$last.items' }], by: 1 } },
			{ id: 'counter.add', params: { by: '$x.value' } },
			{ id: 'counter.add', params: { by: '$1' } }
		] }],
		['run_commands', { steps: [{ id: 'counter.add', params: { by: '$last.id' } }] }],
		['run_commands', { atomic: true, label: 'Two adds', steps: [{ id: 'counter.add', params: { by: 1 } }, { id: 'counter.add', params: { by: '$0.value' } }] }],
		['run_commands', { atomic: true, steps: [{ id: 'counter.add', params: { by: 1 } }, { id: 'counter.fail' }, { id: 'counter.add' }] }],
		['run_commands', { atomic: true, steps: [{ id: 'counter.add' }, { id: 'counter.add', params: { by: '$3.value' } }] }],
		['counter_add', { by: 3 }],
		['counter_reset', {}],
		['counter_reset', {}],
		['canvas_thing', {}],
		['counter_nan', {}],
		['list_commands', { filter: 'x' }]
	];
	out.calls = [];
	for (const [name, args] of calls) {
		const r = await tools.callTool(name, args);
		(out.calls as any[]).push({ name, args, result: norm(r), value: ctx.value, undo: history.getState().undoName, undoCount: history.getState().undoCount });
	}
	const none = setup(false);
	out.unsupported = norm(await none.tools.callTool('run_commands', { atomic: true, steps: [{ id: 'counter.add' }] }));

	out.fuzzy = [
		['al', 'Align Left'], ['ς', 'ΟΔΟΣ'], ['σ', 'ΟΔΟΣ'], ['i', 'İstanbul'], ['st', 'İstanbul'], ['😀', 'a😀'], ['a l', 'Align Left'],
		['x', 'File › X'], ['e', 'é'], ['AB', 'xx(ab'], ['  ', 'x'], ['ss', 'Straße'], ['k', 'K'], ['ǆ', 'ǅ']
	].map(([q, t]) => [q, t, fuzzyMatch(q, t)]);
	out.exact = [
		['settings', ['Settings…']], ['settings', ['Settings...']], ['settings', ['Settings....']], ['x', ['  X  ']], ['', ['']], ['οδος', ['ΟΔΟΣ']]
	].map(([q, n]) => [q, n, exactBonus(q as string, n as string[])]);
	const entries = [
		{ id: 'view.settings', label: 'Color Settings', group: 'View' },
		{ id: 'app.settings', label: 'Settings', group: 'App' },
		{ id: 'canvas.alignLeft', label: 'Align Left', group: 'Arrange', keywords: ['flush'] },
		{ id: 'history.undo', label: 'Undo', group: 'Edit', enabled: false },
		{ id: 'history.redo', label: 'Redo', group: 'Edit' },
		{ id: 'a.b', label: 'Ab', group: '' },
		{ id: 'a.c', label: 'Ac' }
	];
	out.rank = ['settings', 'flush', 'arrange left', 'history', 'do', 'zzz', 'al', 'a', 'e', ' S '].map((q) => [q, rankCommands(q, entries).map((r) => [r.entry.id, r.score, r.labelIndices])]);
	out.rankRecents = rankCommands('e', entries, { recents: ['history.redo', 'app.settings', 'a.b', 'a.c', 'view.settings'] }).map((r) => [r.entry.id, r.score]);
	out.rankEmpty = rankCommands('', entries, { recents: ['history.redo', 'missing', 'history.redo', 'app.settings'], recentLimit: -1 }).map((r) => [r.entry.id, r.score, r.recent]);
	return out;
}

describe('Swift command test vectors', () => {
	it('match the committed fixture (the Swift tests read it)', async () => {
		const now = JSON.stringify(await vectors(), null, 1) + '\n';
		if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, now);
		expect(readFileSync(FILE, 'utf8')).toBe(now);
	});
});
