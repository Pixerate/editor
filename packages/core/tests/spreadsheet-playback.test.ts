import { describe, expect, it } from 'vitest';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '../src/tools';
import { createSpreadsheetToolProvider } from '../src/agent';
import { SpreadsheetController, parseSpreadsheetPlaybackRef, planSpreadsheetToolPlayback } from '../src/spreadsheet';

function setup() {
	const controller = new SpreadsheetController();
	const registry = new ToolRegistry();
	registry.register(createSpreadsheetToolProvider(controller, { id: 'sheet', namespace: 'sheet' }));
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	playback.install(registry);
	// One cell is 100 × 20 px; the grid starts at (0, 0).
	const locate = (ref: PlaybackRef) => {
		const r = parseSpreadsheetPlaybackRef(ref);
		if (!r) return null;
		const c0 = r.startCol ?? 0;
		const c1 = r.endCol ?? 5;
		const r0 = r.startRow ?? 0;
		const r1 = r.endRow ?? 19;
		return { x: c0 * 100, y: r0 * 20, width: (c1 - c0 + 1) * 100, height: (r1 - r0 + 1) * 20 };
	};
	const presence = new PresenceStore();
	playback.attach('spreadsheet', { presence, locate, defaultKind: 'cell', bounds: () => ({ x: 0, y: 0, width: 600, height: 400 }) });
	return { controller, registry, playback, presence };
}

describe('parseSpreadsheetPlaybackRef', () => {
	it('reads cells, ranges, rows and columns', () => {
		expect(parseSpreadsheetPlaybackRef({ kind: 'cell', id: 'B2' })).toEqual({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 });
		expect(parseSpreadsheetPlaybackRef({ kind: 'cell', id: 'D5:b2' })).toEqual({ startRow: 1, endRow: 4, startCol: 1, endCol: 3 });
		expect(parseSpreadsheetPlaybackRef({ kind: 'row', id: '5:7' })).toEqual({ startRow: 4, endRow: 6, startCol: null, endCol: null });
		expect(parseSpreadsheetPlaybackRef({ kind: 'column', id: 'C' })).toEqual({ startRow: null, endRow: null, startCol: 2, endCol: 2 });
		expect(parseSpreadsheetPlaybackRef({ kind: 'cell', id: 'nope' })).toBeNull();
		expect(parseSpreadsheetPlaybackRef({ kind: 'layer', id: 'B2' })).toBeNull();
	});
});

describe('planSpreadsheetToolPlayback', () => {
	it('clicks a cell and types its value', () => {
		expect(planSpreadsheetToolPlayback('set_cell', { cell: 'C7', value: 24 })).toEqual([
			{ type: 'target', ref: { kind: 'cell', id: 'C7' } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'type', text: '24' }
		]);
	});

	it('drags across the block set_range fills', () => {
		const steps = planSpreadsheetToolPlayback('set_range', { start: 'F2', values: [['Status', 'Total'], ['=A1', null]] })!;
		expect(steps.map((s) => s.type)).toEqual(['target', 'press', 'target', 'release', 'type']);
		expect(steps[2]).toEqual({ type: 'target', ref: { kind: 'cell', id: 'F2:G3' } });
	});

	it('marks inserted or deleted rows and columns', () => {
		expect(planSpreadsheetToolPlayback('insert_rows', { before: 3, count: 2 })![0]).toEqual({ type: 'target', ref: { kind: 'row', id: '3:4' } });
		expect(planSpreadsheetToolPlayback('delete_columns', { start: 'b' })![0]).toEqual({ type: 'target', ref: { kind: 'column', id: 'B:B' } });
		expect(planSpreadsheetToolPlayback('get_range', { range: 'A1:B2' })).toBeNull();
	});
});

describe('spreadsheet tools through playback', () => {
	it('every write tool plans its steps, and the provider plays on the spreadsheet surface', () => {
		const provider = createSpreadsheetToolProvider(new SpreadsheetController(), { id: 'sheet' });
		expect(provider.playbackSurface).toBe('spreadsheet');
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		expect(tools.every((t) => typeof t.plan === 'function')).toBe(true);
	});

	it('types a value into a cell, with the same result as without playback', async () => {
		const a = setup();
		const steps = a.playback.record();
		const res = await a.registry.callTool('sheet__set_cell', { cell: 'B3', value: 'Hello' });
		expect(res.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
		expect(a.presence.get('agent')).toMatchObject({ x: 150, y: 50 });

		const b = setup();
		b.playback.speed = Infinity;
		expect(await b.registry.callTool('sheet__set_cell', { cell: 'B3', value: 'Hello' })).toEqual(res);
	});

	it('glances at a read range', async () => {
		const { registry, playback } = setup();
		const steps = playback.record();
		await registry.callTool('sheet__get_range', { range: 'A1:C3' });
		expect(steps.map((r) => r.step)).toEqual([{ type: 'target', ref: { kind: 'cell', id: 'A1:C3' } }, { type: 'commit' }]);
	});

	it('returns errors unchanged', async () => {
		const { registry } = setup();
		const res = await registry.callTool('sheet__set_cell', { cell: 'not a cell', value: 1 });
		expect(res.isError).toBe(true);
		expect((res.content[0] as { text: string }).text).toMatch(/Invalid cell reference/);
	});
});
