import { describe, expect, it } from 'vitest';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, runToolScript, toolResultValue, type ToolScriptEvent } from '../src/tools';

function setup() {
	const registry = new ToolRegistry();
	let next = 0;
	registry.register({
		id: 'notes',
		tools: [
			{ name: 'add', description: 'add', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: ({ text }) => ({ id: `n${++next}`, text }) },
			{ name: 'fail', description: 'fail', inputSchema: { type: 'object', properties: {} }, handler: () => { throw new Error('No such note; list them first.'); } }
		]
	});
	return registry;
}

const instant = () => Promise.resolve();

describe('runToolScript', () => {
	it('plays notes and calls in order, with later args built from earlier results', async () => {
		const registry = setup();
		const events: ToolScriptEvent[] = [];
		const { ok, ctx } = await runToolScript(
			registry,
			{
				id: 's',
				prompt: 'Add two notes',
				steps: [
					{ say: 'First a note.', tool: 'notes__add', args: { text: 'a' }, as: 'first' },
					{ tool: 'notes__add', args: (c) => ({ text: `after ${c.results.first.id}` }) }
				]
			},
			{ onEvent: (e) => events.push(e), wait: instant }
		);
		expect(ok).toBe(true);
		expect(ctx.last).toEqual({ id: 'n2', text: 'after n1' });
		expect(events.map((e) => e.type)).toEqual(['say', 'call', 'result', 'call', 'result', 'done']);
	});

	it('stops at the first failure with its message', async () => {
		const registry = setup();
		const events: ToolScriptEvent[] = [];
		const { ok } = await runToolScript(registry, { id: 's', prompt: 'p', steps: [{ tool: 'notes__fail' }, { tool: 'notes__add' }] }, { onEvent: (e) => events.push(e), wait: instant });
		expect(ok).toBe(false);
		expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'No such note; list them first.' });
		expect(events.filter((e) => e.type === 'call')).toHaveLength(1);
	});

	it("shows notes on the playback cursor and makes calls as the script's actor", async () => {
		const registry = setup();
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const presence = new PresenceStore();
		playback.attach('notes', { presence, locate: () => ({ x: 0, y: 0, width: 10, height: 10 }) });
		await runToolScript(registry, { id: 's', prompt: 'p', steps: [{ tool: 'notes__add', args: { text: 'x', id: 'spot' } }, { say: 'Done adding.' }] }, { playback, actor: { id: 'tour', name: 'Tour' }, wait: instant });
		expect(presence.get('tour')?.message).toBe('Done adding.');
	});

	it('reads JSON text results as values', () => {
		expect(toolResultValue({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
		expect(toolResultValue({ content: [{ type: 'text', text: 'plain' }] })).toBe('plain');
	});
});
