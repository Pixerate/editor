import { describe, expect, it, vi } from 'vitest';
import { createHistoryManager } from '../src/history';
import {
	checkMarkdownStyle,
	createStyleResolver,
	createTextChangeFeed,
	createTextProposals,
	createTextProposalToolProvider,
	diffText,
	memoryStyleStore,
	richTextStyleDomain,
	textChangeBoundary,
	ToolRegistry,
	type TextChange,
	type TextProposalOutcomeEvent
} from '../src/tools';

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** A text with an undo history, as an editor would hold it. */
const doc = (initial: string) => {
	let text = initial;
	let caret = initial.length;
	const listeners = new Set<() => void>();
	const history = createHistoryManager();
	const set = (next: string, at = next.length) => {
		text = next;
		caret = at;
		listeners.forEach((l) => l());
	};
	return {
		get: () => text,
		caret: () => ({ from: caret, to: caret }),
		history,
		subscribe: (l: () => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		/** The person types `s` at `at`. */
		type: (s: string, at = caret) => set(text.slice(0, at) + s + text.slice(at), at + s.length),
		set,
		/** Applies an edit as one undo step by `origin`. */
		apply: (edit: { from: number; to: number; replacement: string }, step: { name: string; origin: string }) => {
			const before = text;
			const after = before.slice(0, edit.from) + edit.replacement + before.slice(edit.to);
			history.execute({ name: step.name, origin: step.origin, execute: () => set(after, edit.from + edit.replacement.length), undo: () => set(before, edit.to) });
		}
	};
};

describe('diffText', () => {
	it('finds the one range that changed', () => {
		expect(diffText('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, removed: '', inserted: 'brave ' });
		expect(diffText('abc', 'abc')).toBeNull();
		expect(diffText('utilize it', 'use it')).toEqual({ from: 1, to: 6, removed: 'tiliz', inserted: 's' });
	});

	it('places an ambiguous edit at the caret', () => {
		expect(diffText('aa', 'aaa')).toEqual({ from: 2, to: 2, removed: '', inserted: 'a' });
		expect(diffText('aa', 'aaa', 1)).toEqual({ from: 0, to: 0, removed: '', inserted: 'a' });
		expect(diffText('aaa', 'aa', 0)).toEqual({ from: 0, to: 1, removed: 'a', inserted: '' });
	});

	it('never splits a surrogate pair', () => {
		expect(diffText('😀', '😃')).toEqual({ from: 0, to: 2, removed: '😀', inserted: '😃' });
	});

	it('reads word and line boundaries', () => {
		expect(textChangeBoundary({ from: 0, to: 0, removed: '', inserted: ' ' })).toBe('word');
		expect(textChangeBoundary({ from: 0, to: 0, removed: '', inserted: '.' })).toBe('word');
		expect(textChangeBoundary({ from: 0, to: 0, removed: '', inserted: '\n' })).toBe('line');
		expect(textChangeBoundary({ from: 0, to: 0, removed: '', inserted: 'a' })).toBeUndefined();
		expect(textChangeBoundary({ from: 0, to: 1, removed: 'a', inserted: '' })).toBeUndefined();
	});
});

describe('createTextChangeFeed', () => {
	const setup = (initial = 'Hello') => {
		vi.useFakeTimers();
		const d = doc(initial);
		let now = 1000;
		const feed = createTextChangeFeed({ getText: d.get, getSelection: d.caret, history: d.history, subscribe: d.subscribe, burstMs: 500, now: () => now++ });
		const changes: TextChange[] = [];
		feed.subscribe((c) => changes.push(c));
		return { d, feed, changes };
	};

	it('reports typing as a burst that ends after a pause, with word boundaries', async () => {
		const { d, changes } = setup();
		d.type(' ');
		await tick();
		d.type('w');
		await tick();
		expect(changes.map((c) => [c.seq, c.origin, c.edit?.inserted, c.boundary, c.inGesture])).toEqual([
			[1, 'user', ' ', 'word', true],
			[2, 'user', 'w', undefined, true]
		]);
		expect(changes[0].edit).toEqual({ from: 5, to: 5, removed: '', inserted: ' ' });
		expect(changes[0].selection).toEqual({ before: { from: 5, to: 5 }, after: { from: 6, to: 6 } });
		expect(changes[1].length).toBe(7);
		vi.advanceTimersByTime(499);
		expect(changes).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(changes[2]).toMatchObject({ seq: 3, origin: 'user', inGesture: false, gestureEnded: true });
		expect(changes[2].edit).toBeUndefined();
		vi.useRealTimers();
	});

	it("tags an agent's history step with its origin and ends the person's burst", async () => {
		const { d, changes } = setup('We utilize it');
		d.type('!');
		await tick();
		d.apply({ from: 3, to: 10, replacement: 'use' }, { name: 'Use the house term', origin: 'agent:jazz' });
		await tick();
		const agent = changes[1];
		expect(agent.origin).toBe('agent:jazz');
		expect(agent.commit?.kind).toBe('execute');
		expect(agent.edit).toEqual({ from: 3, to: 10, removed: 'utilize', inserted: 'use' });
		expect(agent.inGesture).toBe(false);
		expect(agent.gestureEnded).toBe(true);
		// Undo is the person's.
		d.history.undo();
		await tick();
		expect(changes[2].origin).toBe('user');
		expect(changes[2].commit?.kind).toBe('undo');
		vi.useRealTimers();
	});

	it('takes an origin from the host, ends a burst on request, and resets', async () => {
		const { d, feed, changes } = setup();
		feed.noteOrigin('agent:swash');
		d.type('!');
		await tick();
		expect(changes[0].origin).toBe('agent:swash');
		d.type('?');
		await tick();
		expect(changes[1].origin).toBe('user');
		expect(feed.endGesture()?.gestureEnded).toBe(true);
		expect(feed.endGesture()).toBeNull();
		d.set('Replaced');
		d.set('Replaced twice');
		await tick();
		// Two notifications in one tick are one change.
		expect(changes).toHaveLength(4);
		expect(changes[3].edit?.inserted).toBe('Replaced twice');
		feed.reset();
		expect(feed.check()).toBeNull();
		expect(feed.text()).toBe('Replaced twice');
		feed.dispose();
		d.type('x');
		await tick();
		expect(changes).toHaveLength(4);
		vi.useRealTimers();
	});

	it('turns bursts off with burstMs 0', () => {
		const d = doc('a');
		const feed = createTextChangeFeed({ getText: d.get, burstMs: 0 });
		d.type('b');
		expect(feed.check('user')?.inGesture).toBe(false);
	});
});

describe('createTextProposals', () => {
	const setup = (initial: string, readOnly?: string) => {
		const d = doc(initial);
		let n = 0;
		const proposals = createTextProposals({ getText: d.get, applyEdit: d.apply, subscribe: d.subscribe, origin: 'agent:jazz', idGenerator: () => `p${++n}`, now: () => 0, readOnly: () => readOnly ?? false });
		const outcomes: TextProposalOutcomeEvent[] = [];
		proposals.onOutcome((e) => outcomes.push(e));
		return { d, proposals, outcomes };
	};

	it('proposes without changing the text, then accepts as one undo step by the proposer', () => {
		const { d, proposals, outcomes } = setup('We utilize the tool.');
		const p = proposals.propose({ from: 3, to: 10, replacement: 'use', expected: 'utilize', check: 'terms', rationale: 'House term.' });
		expect(p).toEqual({ id: 'p1', from: 3, to: 10, original: 'utilize', replacement: 'use', title: 'Replace "utilize" with "use"', rationale: 'House term.', check: 'terms', origin: 'agent:jazz', createdAt: 0 });
		expect(d.get()).toBe('We utilize the tool.');
		expect(proposals.accept('p1')).toEqual({ proposalId: 'p1', from: 3, to: 6, text: 'use', historyLabel: 'Replace "utilize" with "use"', origin: 'agent:jazz' });
		expect(d.get()).toBe('We use the tool.');
		expect(d.history.getState().undoCount).toBe(1);
		expect(d.history.getEntries?.()?.[0]?.origin ?? 'agent:jazz').toBe('agent:jazz');
		expect(proposals.getState().proposals).toEqual([]);
		expect(outcomes.map((o) => [o.proposal.id, o.outcome])).toEqual([['p1', 'accepted']]);
		d.history.undo();
		expect(d.get()).toBe('We utilize the tool.');
	});

	it('moves proposals as the person writes before them, and drops one whose text they edit', () => {
		const { d, proposals, outcomes } = setup('We utilize the tool. It is utilized daily.');
		proposals.propose({ from: 3, to: 10, replacement: 'use' });
		proposals.propose({ from: 27, to: 35, replacement: 'used' });
		d.type('Now ', 0);
		expect(proposals.getState().proposals.map((p) => [p.id, p.from, p.to, d.get().slice(p.from, p.to)])).toEqual([
			['p1', 7, 14, 'utilize'],
			['p2', 31, 39, 'utilized']
		]);
		// The person fixes the first one themselves: it goes stale.
		d.set(d.get().replace('utilize the', 'employ the'));
		expect(proposals.getState().proposals.map((p) => p.id)).toEqual(['p2']);
		expect(proposals.get('p2')!.from).toBe(30);
		expect(outcomes.map((o) => [o.proposal.id, o.outcome])).toEqual([['p1', 'stale']]);
	});

	it('re-anchors a proposal whose text is wrapped in syntax', () => {
		const { d, proposals } = setup('We utilize the tool.');
		proposals.propose({ from: 3, to: 10, replacement: 'use' });
		d.set('We **utilize** the tool.');
		expect(proposals.get('p1')).toMatchObject({ from: 5, to: 12 });
		proposals.accept('p1');
		expect(d.get()).toBe('We **use** the tool.');
	});

	it('keeps other proposals in step when one is accepted, and drops those it overlapped', () => {
		const { d, proposals, outcomes } = setup('Alpha beta gamma');
		proposals.propose({ from: 0, to: 5, replacement: 'A' });
		proposals.propose({ from: 11, to: 16, replacement: 'G' });
		proposals.propose({ from: 0, to: 10, replacement: 'AB' });
		proposals.accept('p1');
		expect(d.get()).toBe('A beta gamma');
		expect(proposals.get('p2')).toMatchObject({ from: 7, to: 12, original: 'gamma' });
		expect(proposals.get('p3')).toBeUndefined();
		expect(outcomes.map((o) => [o.proposal.id, o.outcome])).toEqual([
			['p3', 'stale'],
			['p1', 'accepted']
		]);
	});

	it('refuses bad proposals and read-only accepts, changing nothing', () => {
		const { proposals } = setup('Hello');
		expect(() => proposals.propose({ from: 2, to: 9, replacement: 'x' })).toThrow('0 ≤ from ≤ to ≤ 5');
		expect(() => proposals.propose({ from: 0, to: 5, replacement: 'x', expected: 'Help' })).toThrow('it changed since you read it');
		expect(() => proposals.propose({ from: 0, to: 5, replacement: 'Hello' })).toThrow('would change nothing');
		expect(() => proposals.accept('nope')).toThrow('There are no pending proposals');
		const ro = setup('Hello', 'The note is locked.');
		ro.proposals.propose({ from: 0, to: 0, replacement: 'Oh, ' });
		expect(() => ro.proposals.accept('p1')).toThrow('The note is locked.');
		expect(ro.d.get()).toBe('Hello');
		expect(ro.proposals.getState().proposals).toHaveLength(1);
	});

	it('rejects and clears with outcomes', () => {
		const { proposals, outcomes } = setup('One two three');
		proposals.propose({ from: 0, to: 3, replacement: '1' });
		proposals.propose({ from: 4, to: 7, replacement: '2', origin: 'agent:other' });
		proposals.propose({ from: 8, to: 13, replacement: '3' });
		expect(proposals.reject('p1').id).toBe('p1');
		expect(proposals.clear('agent:jazz')).toEqual(['p3']);
		expect(proposals.clear()).toEqual(['p2']);
		expect(outcomes.map((o) => [o.proposal.id, o.outcome])).toEqual([
			['p1', 'rejected'],
			['p3', 'cleared'],
			['p2', 'cleared']
		]);
	});

	it('turns house-style findings into proposals', async () => {
		const source = '# Our New Plan\n\nWe utilize it.\n';
		const styles = createStyleResolver({
			layers: [{ id: 'org', store: memoryStyleStore({ 'h/SKILL.md': '---\nname: h\ndescription: House.\ndomains: [rich-text]\n---\n', 'h/rich-text.json': JSON.stringify({ headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case', 'terms'] }) }) }],
			domains: [richTextStyleDomain]
		});
		const { d, proposals } = setup(source);
		const report = await checkMarkdownStyle(source, styles);
		for (const f of report.findings) if (f.target?.replacement !== undefined) proposals.propose({ ...f.target, replacement: f.target.replacement, check: f.check, rationale: f.message });
		for (const p of [...proposals.getState().proposals]) proposals.accept(p.id);
		expect(d.get()).toBe('# Our new plan\n\nWe use it.\n');
		expect(d.history.getState().undoCount).toBe(2);
	});
});

describe('createTextProposalToolProvider', () => {
	const setup = (readOnly?: boolean | string) => {
		const d = doc('We utilize the tool.');
		let n = 0;
		const proposals = createTextProposals({ getText: d.get, applyEdit: d.apply, subscribe: d.subscribe, idGenerator: () => `p${++n}`, now: () => 0 });
		const registry = new ToolRegistry();
		registry.register(createTextProposalToolProvider(proposals, { namespace: '', ...(readOnly !== undefined ? { readOnly } : {}) }));
		return { d, registry, proposals };
	};

	it('proposes, lists and accepts as the calling agent', async () => {
		const { d, registry } = setup();
		const proposed = await registry.callTool('propose_text_edit', { from: 3, to: 10, replacement: 'use', expected: 'utilize', check: 'terms' }, { actor: { id: 'jazz', name: 'Jazz' } as never });
		expect(proposed.isError).toBeFalsy();
		expect(proposed.structuredContent).toEqual({ proposalId: 'p1', from: 3, to: 10, original: 'utilize', replacement: 'use', title: 'Replace "utilize" with "use"', check: 'terms', origin: 'agent:jazz' });
		const listed = (await registry.callTool('list_text_proposals')).structuredContent as any;
		expect(listed.readOnly).toBeNull();
		expect(listed.proposals.map((p: any) => p.id)).toEqual(['p1']);
		const accepted = (await registry.callTool('accept_text_proposal', { proposalId: 'p1' })).structuredContent as any;
		expect(accepted).toEqual({ proposalId: 'p1', from: 3, to: 6, text: 'use', historyLabel: 'Replace "utilize" with "use"', origin: 'agent:jazz' });
		expect(d.get()).toBe('We use the tool.');
	});

	it('rejects, and reports useful errors', async () => {
		const { registry } = setup();
		await registry.callTool('propose_text_edit', { from: 0, to: 2, replacement: 'They' });
		expect((await registry.callTool('reject_text_proposal', { proposalId: 'p1' })).structuredContent).toEqual({ proposalId: 'p1', title: 'Replace "We" with "They"', rejected: true });
		const missing = await registry.callTool('accept_text_proposal', { proposalId: 'p1' });
		expect(missing.isError).toBe(true);
		expect(JSON.stringify(missing.content)).toContain('list_text_proposals');
		const stale = await registry.callTool('propose_text_edit', { from: 3, to: 10, replacement: 'use', expected: 'employ' });
		expect(stale.isError).toBe(true);
		expect(JSON.stringify(stale.content)).toContain('Read the text again');
		expect((await registry.callTool('propose_text_edit', { from: 3, replacement: 'x' })).isError).toBe(true);
		expect((await registry.callTool('propose_text_edit', { from: -1, to: 2, replacement: 'x' })).isError).toBe(true);
		expect((await registry.callTool('propose_text_edit', { from: 0, to: 2, replacement: 'x', extra: true })).isError).toBe(true);
	});

	it('refuses to accept on a read-only text but still proposes and lists', async () => {
		const { d, registry } = setup('The note is locked.');
		await registry.callTool('propose_text_edit', { from: 3, to: 10, replacement: 'use' });
		expect(((await registry.callTool('list_text_proposals')).structuredContent as any).readOnly).toBe('The note is locked.');
		const accept = await registry.callTool('accept_text_proposal', { proposalId: 'p1' });
		expect(accept.isError).toBe(true);
		expect(JSON.stringify(accept.content)).toContain('The note is locked.');
		expect(d.get()).toBe('We utilize the tool.');
	});
});
