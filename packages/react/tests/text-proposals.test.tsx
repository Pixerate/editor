import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import { ToolRegistry, createTextProposalToolProvider, type TextChange } from '@pixerate/editor/tools';
import { useTextChangeFeed, useTextProposals, type TextProposalsHandle } from '../src';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function mount(history: HistoryManager, heard: TextChange[]) {
	const out: { handle?: TextProposalsHandle; text?: string; setText?: (t: string) => void } = {};
	function Probe() {
		const [text, setText] = useState('We utilize the tool.');
		out.handle = useTextProposals({
			text,
			origin: 'agent:jazz',
			applyEdit: (edit, step) => {
				let before = '';
				setText((t) => {
					before = t;
					return t.slice(0, edit.from) + edit.replacement + t.slice(edit.to);
				});
				history.execute({ name: step.name, origin: step.origin, execute: () => {}, undo: () => setText(before) });
			}
		});
		useTextChangeFeed({ text, history, burstMs: 0, onChange: (c) => heard.push(c) });
		out.text = text;
		out.setText = setText;
		return null;
	}
	return { out, Probe };
}

describe('useTextProposals and useTextChangeFeed', () => {
	it('proposes without changing the text, follows typing, accepts as the proposer, and the feed reports it', async () => {
		const history = new HistoryManager();
		const heard: TextChange[] = [];
		const { out, Probe } = mount(history, heard);
		await act(async () => root.render(<StrictMode><Probe /></StrictMode>));
		let id = '';
		await act(async () => {
			id = out.handle!.propose({ from: 3, to: 10, replacement: 'use', expected: 'utilize' }).id;
		});
		expect(out.handle!.proposals.map((p) => p.id)).toEqual([id]);
		expect(out.text).toBe('We utilize the tool.');
		await act(async () => out.setText!('So We utilize the tool.'));
		expect(out.handle!.proposals[0]).toMatchObject({ from: 6, to: 13 });
		expect(heard.at(-1)).toMatchObject({ origin: 'user', edit: { from: 0, to: 0, inserted: 'So ' } });
		await act(async () => {
			out.handle!.accept(id);
		});
		expect(out.text).toBe('So We use the tool.');
		expect(out.handle!.proposals).toEqual([]);
		expect(heard.at(-1)).toMatchObject({ origin: 'agent:jazz', edit: { removed: 'utilize', inserted: 'use' } });
		expect(history.getState().undoName).toBe('Replace "utilize" with "use"');
	});

	it('drives the store through the agent tools', async () => {
		const history = new HistoryManager();
		const { out, Probe } = mount(history, []);
		await act(async () => root.render(<Probe />));
		const registry = new ToolRegistry();
		registry.register(createTextProposalToolProvider(out.handle!.store, { namespace: '' }));
		let proposalId = '';
		await act(async () => {
			proposalId = ((await registry.callTool('propose_text_edit', { from: 3, to: 10, replacement: 'use' })).structuredContent as any).proposalId;
		});
		expect(out.handle!.proposals).toHaveLength(1);
		await act(async () => {
			await registry.callTool('reject_text_proposal', { proposalId });
		});
		expect(out.handle!.proposals).toHaveLength(0);
		expect(out.text).toBe('We utilize the tool.');
	});
});
