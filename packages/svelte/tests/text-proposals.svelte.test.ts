import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import { HistoryManager } from '@pixerate/editor/history';
import type { TextChange } from '@pixerate/editor/tools';
import { createTextChangeWatcher, createTextProposalState } from '../src';

describe('createTextProposalState and createTextChangeWatcher (Svelte)', () => {
	it('proposes without changing the text, follows typing, accepts as the proposer, and the watcher reports it', async () => {
		const history = new HistoryManager();
		const heard: TextChange[] = [];
		let text = $state('We utilize the tool.');
		let state!: ReturnType<typeof createTextProposalState>;
		let watcher!: ReturnType<typeof createTextChangeWatcher>;
		const cleanup = $effect.root(() => {
			state = createTextProposalState({
				getText: () => text,
				origin: 'agent:jazz',
				applyEdit: (edit, step) => {
					const before = text;
					const after = before.slice(0, edit.from) + edit.replacement + before.slice(edit.to);
					history.execute({ name: step.name, origin: step.origin, execute: () => (text = after), undo: () => (text = before) });
				}
			});
			watcher = createTextChangeWatcher({ getText: () => text, history, burstMs: 0, onChange: (c) => heard.push(c) });
		});
		flushSync();
		const p = state.propose({ from: 3, to: 10, replacement: 'use' });
		expect(state.proposals.map((x) => x.id)).toEqual([p.id]);
		text = 'So We utilize the tool.';
		flushSync();
		expect(state.proposals[0]).toMatchObject({ from: 6, to: 13 });
		expect(watcher.last).toMatchObject({ origin: 'user', edit: { from: 0, to: 0, inserted: 'So ' } });
		state.accept(p.id);
		flushSync();
		expect(text).toBe('So We use the tool.');
		expect(state.proposals).toEqual([]);
		expect(heard.at(-1)).toMatchObject({ origin: 'agent:jazz', edit: { removed: 'utilize', inserted: 'use' } });
		history.undo();
		flushSync();
		expect(text).toBe('So We utilize the tool.');
		cleanup();
	});
});
