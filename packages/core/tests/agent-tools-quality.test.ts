import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import {
	ToolRegistry,
	createMcpServer,
	createRichTextToolProvider,
	createSpreadsheetToolProvider,
	createEditorMcpToolProvider,
	validateAgentCommand,
	validateJsonSchema,
	EDITOR_CANVAS_TOOLS,
	EDITOR_PROMPT_TOOLS,
	type AgentStep,
	type EditorSnapshot,
	type JsonRpcNotification
} from '../src/agent';
import { createRichTextPreset, SpreadsheetController } from '../src';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const structured = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as any;

describe('validateJsonSchema composition keywords', () => {
	it('validates anyOf / oneOf and reports the closest branch', () => {
		const schema = {
			anyOf: [
				{ type: 'object', properties: { kind: { const: 'a' }, size: { type: 'integer' } }, required: ['kind', 'size'] },
				{ type: 'string' }
			]
		};
		expect(validateJsonSchema('x', schema)).toEqual([]);
		expect(validateJsonSchema({ kind: 'a', size: 2 }, schema)).toEqual([]);
		const errors = validateJsonSchema({ kind: 'a', size: 'big' }, schema);
		expect(errors[0].message).toMatch(/Does not match any allowed shape/);
		expect(errors).toContainEqual({ path: '/size', message: 'Expected integer, got string.' });

		const oneOf = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
		expect(validateJsonSchema(1.5, oneOf)).toEqual([]);
		expect(validateJsonSchema(2, oneOf)[0].message).toMatch(/exactly one/);
	});

	it('validates allOf, not, local $ref and numeric / array keywords', () => {
		const schema = {
			$defs: { id: { type: 'string', minLength: 2 } },
			type: 'object',
			properties: {
				a: { $ref: '#/$defs/id' },
				b: { allOf: [{ type: 'number', exclusiveMinimum: 0 }, { multipleOf: 0.5 }] },
				c: { not: { const: 'forbidden' } },
				d: { type: 'array', uniqueItems: true },
				e: { $ref: '#/$defs/missing' }
			}
		};
		expect(validateJsonSchema({ a: 'ok', b: 1.5, c: 'fine', d: [1, 2] }, schema)).toEqual([]);
		expect(validateJsonSchema({ a: 'x', b: 0, c: 'forbidden', d: [1, 1], e: 1 }, schema)).toEqual([
			{ path: '/a', message: 'Must be at least 2 characters.' },
			{ path: '/b', message: 'Must be > 0.' },
			{ path: '/c', message: 'Matches a disallowed shape.' },
			{ path: '/d/1', message: 'Duplicate item; items must be unique.' },
			{ path: '/e', message: 'Unresolvable schema reference #/$defs/missing.' }
		]);
		expect(validateJsonSchema(0.3, { multipleOf: 0.1 })).toEqual([]);
	});

	it('survives recursive references and names allowed properties', () => {
		const tree = {
			type: 'object',
			properties: { children: { type: 'array', items: { $ref: '#' } } },
			additionalProperties: false
		};
		expect(validateJsonSchema({ children: [{ children: [] }] }, tree)).toEqual([]);
		expect(validateJsonSchema({ children: [{ kids: [] }] }, tree)).toEqual([
			{ path: '/children/0/kids', message: 'Unknown property "kids". Allowed: children.' }
		]);
	});
});

describe('rich-text find / replace tools', () => {
	const setup = (content = '<p>Hello world. Hello again.</p><p>Bye world</p>') => {
		const editor = new Editor({ extensions: createRichTextPreset(), content });
		const registry = new ToolRegistry();
		registry.register(createRichTextToolProvider(editor, { id: 'doc' }));
		return { editor, registry };
	};

	it('find_text returns document positions usable by replace_range', async () => {
		const { editor, registry } = setup();
		const found = structured(await registry.callTool('find_text', { query: 'world' }));
		expect(found.total).toBe(2);
		const [first, second] = found.matches;
		expect(editor.state.doc.textBetween(first.from, first.to)).toBe('world');
		expect(first.before).toBe('Hello ');
		expect(second.before).toContain('Bye ');

		await registry.callTool('replace_range', { from: second.from, to: second.to, text: 'moon' });
		expect(editor.getText()).toContain('Bye moon');

		// Literal by default: regex metacharacters are plain text.
		expect(structured(await registry.callTool('find_text', { query: 'world.' })).total).toBe(1);
		expect(structured(await registry.callTool('find_text', { query: 'h\\w+o', regex: true })).total).toBe(2);
		expect(structured(await registry.callTool('find_text', { query: 'hello', matchCase: true })).total).toBe(0);
		expect((await registry.callTool('find_text', { query: '(', regex: true })).isError).toBe(true);
		editor.destroy();
	});

	it('replace_text replaces all or the n-th match in one step and fails on no match', async () => {
		const { editor, registry } = setup();
		const one = structured(await registry.callTool('replace_text', { find: 'Hello', replace: 'Hi', occurrence: 2 }));
		expect(one).toMatchObject({ replaced: 1, total: 2 });
		expect(editor.getText()).toContain('Hello world. Hi again.');

		const all = structured(await registry.callTool('replace_text', { find: 'world', replace: 'there' }));
		expect(all.replaced).toBe(2);
		expect(editor.getText()).not.toContain('world');
		expect(editor.state.doc.textBetween(all.ranges[0].from, all.ranges[0].to)).toBe('there');

		const none = await registry.callTool('replace_text', { find: 'absent', replace: 'x' });
		expect(none.isError).toBe(true);
		expect(structured(none).error.message).toBe('No match for "absent".');
		const tooFar = await registry.callTool('replace_text', { find: 'Hi', replace: 'x', occurrence: 5 });
		expect(structured(tooFar).error.message).toMatch(/only 1 matches/);

		// One undo step reverts the whole replace-all.
		editor.commands.undo();
		expect(editor.getText()).toContain('Hello world. Hi again.');
		editor.destroy();
	});

	it('get_text blocks, set_selection and range checks', async () => {
		const { editor, registry } = setup('<h1>Title</h1><p>Body</p>');
		const text = structured(await registry.callTool('get_text', { blocks: true }));
		expect(text.blocks).toEqual([
			{ type: 'heading', from: 1, to: 6, text: 'Title' },
			{ type: 'paragraph', from: 8, to: 12, text: 'Body' }
		]);
		const sel = structured(await registry.callTool('set_selection', { from: 8, to: 12 }));
		expect(sel.selection).toMatchObject({ from: 8, to: 12, text: 'Body' });
		await registry.callTool('replace_selection', { text: 'Text' });
		expect(editor.getText()).toContain('Text');

		const backwards = await registry.callTool('replace_range', { from: 5, to: 2, text: 'x' });
		expect(structured(backwards).error.message).toMatch(/must not be after/);
		const outside = await registry.callTool('set_selection', { from: 999 });
		expect(structured(outside).error.message).toMatch(/outside the document/);
		editor.destroy();
	});
});

describe('per-operation editor tools', () => {
	const baseSnapshot = (): EditorSnapshot => ({
		document: { text: 'Hello', selection: { from: 0, to: 0 } },
		canvas: { nodes: [{ id: 'n1', position: { x: 100, y: 100 }, data: {} }], edges: [] }
	});

	const setup = (style?: 'split' | 'combined') => {
		const snapshot = baseSnapshot();
		const applied: AgentStep[] = [];
		const registry = new ToolRegistry();
		registry.register(
			createEditorMcpToolProvider({
				id: 'studio',
				toolStyle: style,
				getSnapshot: () => snapshot,
				applySteps: (steps) => {
					applied.push(...steps);
					for (const step of steps) if (step.type === 'step:canvas_add_node') snapshot.canvas!.nodes.push(step.node);
				},
				plannerOptions: { idGenerator: () => 'generated' }
			})
		);
		return { registry, applied, snapshot };
	};

	it('exposes one strict tool per operation by default', () => {
		const { registry } = setup();
		expect(registry.listTools().tools.map((t) => t.name)).toEqual([
			'get_editor_state',
			...EDITOR_CANVAS_TOOLS.map((t) => t.name),
			...EDITOR_PROMPT_TOOLS.map((t) => t.name)
		]);
		for (const tool of [...EDITOR_CANVAS_TOOLS, ...EDITOR_PROMPT_TOOLS]) {
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
		}
	});

	it('returns the ids of created nodes and edges', async () => {
		const { registry } = setup();
		const added = structured(
			await registry.callTool('canvas_add_node', { node: { data: { label: 'B' } }, nearNodeId: 'n1', side: 'right' })
		);
		expect(added.created.nodes).toEqual([{ id: 'generated', position: expect.any(Object) }]);
		expect(added.created.edges).toEqual([{ id: expect.stringMatching(/^edge-/), source: 'n1', target: 'generated' }]);

		const connected = structured(await registry.callTool('canvas_connect', { source: 'generated', target: 'n1' }));
		expect(connected.created.edges[0]).toMatchObject({ source: 'generated', target: 'n1' });
	});

	it('rejects unknown ids, duplicates and bad ranges with actionable errors', async () => {
		const { registry, applied } = setup();
		const unknown = await registry.callTool('canvas_remove_nodes', { nodeIds: ['n1', 'ghost'] });
		expect(structured(unknown).error.message).toBe('Unknown node id: "ghost". Call get_editor_state for the current ids.');
		expect(structured(await registry.callTool('canvas_add_node', { node: { id: 'n1' } })).error.message).toMatch(/already exists/);
		expect(structured(await registry.callTool('canvas_connect', { source: 'n1', target: 'n1' })).error.message).toMatch(/two different/);
		expect(structured(await registry.callTool('canvas_add_node', { node: {}, nearNodeId: 'ghost' })).error.message).toMatch(/ghost/);
		expect(structured(await registry.callTool('prompt_select', { from: 4, to: 1 })).error.message).toMatch(/must not be after/);
		// Strict schemas: unknown arguments are rejected before anything runs.
		const extra = await registry.callTool('canvas_layout', { direction: 'LR', operation: 'layout' });
		expect(structured(extra).error.code).toBe('invalid_arguments');
		expect(applied).toEqual([]);
	});

	it('passes highlight color and duration through', async () => {
		const { registry, applied } = setup();
		await registry.callTool('canvas_highlight', { nodeIds: ['n1'], color: '#f00', durationMs: 500 });
		expect(applied).toEqual([{ type: 'step:canvas_highlight', nodeIds: ['n1'], color: '#f00', durationMs: 500 }]);
		await registry.callTool('prompt_set_variable', { name: 'tone', value: null });
		expect(applied[1]).toEqual({ type: 'step:prompt_set_variable', name: 'tone', value: null });
	});

	it('keeps the combined tools available and validates them the same way', async () => {
		const { registry } = setup('combined');
		const result = structured(await registry.callTool('edit_canvas', { operation: 'update_node', id: 'ghost', data: {} }));
		expect(result.error.message).toMatch(/Unknown node id/);
		const missing = structured(await registry.callTool('edit_prompt', { operation: 'replace_range', from: 1 }));
		expect(missing.error.message).toBe('Operation "replace_range" requires from, to, text; missing: to, text.');
	});

	it('validateAgentCommand accepts valid commands', () => {
		const snapshot = baseSnapshot();
		expect(validateAgentCommand({ type: 'canvas:select', nodeIds: [] }, snapshot)).toBeNull();
		expect(validateAgentCommand({ type: 'canvas:layout' }, snapshot)).toBeNull();
		expect(validateAgentCommand({ type: 'prompt:insert_text', text: 'x', at: 3 }, snapshot)).toBeNull();
	});
});

describe('spreadsheet bulk and structural tools', () => {
	it('set_range writes a block in one undo step and reports errors', async () => {
		const sheet = new SpreadsheetController();
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));

		const result = structured(
			await registry.callTool('set_range', { start: 'B2', values: [['Qty', 'Price'], [2, 3], ['=B3*C3', '=1/0'], [null, true]] })
		);
		expect(result).toMatchObject({ range: 'B2:C5', written: 8 });
		expect(result.errors.map((e: any) => e.cell)).toEqual(['C4']);
		const read = structured(await registry.callTool('get_range', { range: 'B4' }));
		expect(Number(read.values[0][0])).toBe(6);

		sheet.undo();
		expect(structured(await registry.callTool('get_range', { range: 'B2' })).raw).toEqual([['']]);
	});

	it('set_range grows the sheet and refuses read-only targets without writing', async () => {
		const sheet = new SpreadsheetController({
			document: {
				columns: [
					{ id: 'c0', key: 'A', title: 'A', type: 'freeform' as const },
					{ id: 'c1', key: 'B', title: 'B', type: 'freeform' as const, readOnly: true }
				],
				rows: [{ id: 'r0', index: 0, type: 'freeform' as const }]
			}
		});
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
		const blocked = await registry.callTool('set_range', { start: 'A1', values: [['x', 'y']] });
		expect(structured(blocked).error.message).toBe('Read-only cells: B1. Nothing was written.');
		expect(structured(await registry.callTool('get_range', { range: 'A1' })).raw).toEqual([['']]);

		const grown = structured(await registry.callTool('set_range', { start: 'A2', values: [['a'], ['b']] }));
		expect(grown.sheet.rows).toBe(3);
	});

	it('inserts and deletes rows and columns, shifting references', async () => {
		const sheet = new SpreadsheetController();
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
		await registry.callTool('set_range', { start: 'A1', values: [[5, '=A1*2']] });

		const rows = structured(await registry.callTool('insert_rows', { before: 1, count: 2 }));
		expect(rows).toMatchObject({ inserted: 2, rows: '1:2', sheet: { rows: 12 } });
		expect(structured(await registry.callTool('get_range', { range: 'B3' })).raw).toEqual([['=A3*2']]);

		await registry.callTool('insert_columns', { before: 'A' });
		expect(structured(await registry.callTool('get_range', { range: 'C3' })).raw).toEqual([['=B3*2']]);

		await registry.callTool('delete_columns', { start: 'A' });
		await registry.callTool('delete_rows', { start: 1, count: 2 });
		expect(structured(await registry.callTool('get_range', { range: 'B1' })).raw).toEqual([['=A1*2']]);

		expect(structured(await registry.callTool('delete_rows', { start: 50 })).error.message).toMatch(/not all in the sheet/);
		expect(structured(await registry.callTool('insert_columns', { before: '1' })).error.message).toMatch(/Invalid column/);
	});

	it('merges, reports and unmerges a range without a selection', async () => {
		const sheet = new SpreadsheetController();
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
		await registry.callTool('set_range', { start: 'A1', values: [['Title', 'x', '']] });

		const merged = structured(await registry.callTool('merge_cells', { range: 'A1:C1' }));
		expect(merged).toEqual({ merged: 'A1:C1', cleared: ['B1'] });
		expect(structured(await registry.callTool('get_range', { range: 'B1:D2' })).merges).toEqual(['A1:C1']);
		expect(structured(await registry.callTool('get_range', { range: 'A1' })).raw).toEqual([['Title']]);

		sheet.undo();
		expect(sheet.getMerges()).toEqual([]);
		expect(structured(await registry.callTool('get_range', { range: 'B1' })).raw).toEqual([['x']]);
		await registry.callTool('merge_cells', { range: 'A1:C1' });

		const partial = structured(await registry.callTool('merge_cells', { range: 'B1:D2' }));
		expect(partial.error.message).toBe('B1:D2 partly overlaps the merged range A1:C1; include all of it or unmerge it first.');
		expect(structured(await registry.callTool('merge_cells', { range: 'B5' })).error.message).toMatch(/single cell/);
		expect(structured(await registry.callTool('merge_cells', { range: 'A1:ZZ1' })).error.message).toMatch(/outside the sheet/);

		expect(structured(await registry.callTool('unmerge_cells', { range: 'B1' }))).toEqual({ unmerged: ['A1:C1'] });
		expect(sheet.getMerges()).toEqual([]);
		expect(structured(await registry.callTool('unmerge_cells', { range: 'A1' })).error.message).toMatch(/No merged cells in A1/);
	});

	it('refuses to merge read-only cells', async () => {
		const sheet = new SpreadsheetController({
			document: {
				columns: [
					{ id: 'c0', key: 'A', title: 'A', type: 'freeform' as const },
					{ id: 'c1', key: 'B', title: 'B', type: 'freeform' as const, readOnly: true }
				],
				rows: [{ id: 'r0', index: 0, type: 'freeform' as const }]
			}
		});
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
		const blocked = structured(await registry.callTool('merge_cells', { range: 'A1:B1' }));
		expect(blocked.error.message).toBe('Read-only cells: B1. Nothing was merged.');
		expect(sheet.getMerges()).toEqual([]);
	});

	it('transposes a range in place and moves formulas with their cells', async () => {
		const sheet = new SpreadsheetController();
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet' }));
		await registry.callTool('set_range', { start: 'A1', values: [[1, 2, 3], [4, 5, '=A1+B1']] });

		const result = structured(await registry.callTool('transpose_range', { range: 'A1:C2' }));
		expect(result.range).toBe('A1:B3');
		const read = structured(await registry.callTool('get_range', { range: 'A1:B3' }));
		expect(read.raw).toEqual([['1', '4'], ['2', '5'], ['3', '=A1+A2']]);
		expect(Number(read.values[2][1])).toBe(3);

		// Transposing A1:B3 back would cover C1, which is now in a merge.
		expect(structured(await registry.callTool('merge_cells', { range: 'C1:D1' }))).toMatchObject({ merged: 'C1:D1' });
		const blocked = structured(await registry.callTool('transpose_range', { range: 'A1:B3' }));
		expect(blocked.error.message).toBe('Cannot transpose A1:B3: the merged range C1:D1 is in the way; unmerge it first.');
		expect(structured(await registry.callTool('transpose_range', { range: 'A1:C2:D4' })).error.message).toMatch(/Invalid range/);
	});
});

describe('createMcpServer', () => {
	const setup = () => {
		const registry = new ToolRegistry();
		const sent: JsonRpcNotification[] = [];
		const server = createMcpServer(registry, {
			name: 'pixerate',
			version: '1.0.0',
			instructions: 'Edit the document.',
			send: (m) => sent.push(m)
		});
		return { registry, server, sent };
	};

	const echo = {
		id: 'p',
		tools: [
			{
				name: 'echo',
				title: 'Echo',
				description: 'Echoes text.',
				inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
				handler: ({ text }: Record<string, any>) => text
			},
			{
				name: 'slow',
				description: 'Waits for abort.',
				inputSchema: { type: 'object' as const },
				handler: (_: Record<string, any>, { signal }: { signal?: AbortSignal }) =>
					new Promise((resolve) => signal?.addEventListener('abort', () => resolve('aborted')))
			}
		]
	};

	it('negotiates the protocol and serves tools/list and tools/call', async () => {
		const { registry, server } = setup();
		registry.register(echo);
		const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
		expect(init?.result).toMatchObject({
			protocolVersion: '2025-03-26',
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: 'pixerate', version: '1.0.0' },
			instructions: 'Edit the document.'
		});
		const future = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
		expect((future?.result as any).protocolVersion).toBe('2025-06-18');

		const list = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
		expect((list?.result as any).tools.map((t: any) => t.name)).toEqual(['echo', 'slow']);

		const call = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
		expect(call).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'hi' }] } });

		// Invalid arguments are a tool result the model can read; unknown tools are protocol errors.
		const invalid = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} } });
		expect((invalid?.result as any).isError).toBe(true);
		const unknown = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
		expect(unknown?.error?.code).toBe(-32602);
	});

	it('handles ping, notifications and malformed messages', async () => {
		const { server } = setup();
		expect(await server.handle({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
		expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/whatever' })).toBeNull();
		expect((await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }))?.error?.code).toBe(-32601);
		expect((await server.handle('{oops'))?.error?.code).toBe(-32700);
		expect((await server.handle({ id: 8, method: 'ping' } as any))?.error).toMatchObject({ code: -32600 });
		expect(
			(await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x', arguments: [] } }))?.error?.code
		).toBe(-32602);
	});

	it('announces list changes only after initialization, and stops on close', async () => {
		const { registry, server, sent } = setup();
		registry.register({ ...echo, id: 'early' });
		registry.flush();
		expect(sent).toEqual([]);

		await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(server.initialized).toBe(true);
		registry.register({ id: 'late', namespace: 'late', tools: echo.tools });
		registry.flush();
		expect(sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);

		server.close();
		registry.unregister('late');
		registry.flush();
		expect(sent).toHaveLength(1);
	});

	it('aborts a running call on notifications/cancelled and sends no response', async () => {
		const { registry, server } = setup();
		registry.register(echo);
		const pending = server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'slow' } });
		await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10, reason: 'user' } });
		expect(await pending).toBeNull();
	});
});
