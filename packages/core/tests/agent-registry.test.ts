import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import {
	ToolRegistry,
	ToolRegistryError,
	baseToolName,
	createToolRegistry,
	validateJsonSchema,
	toToolResult,
	toolCallToAgentCommand,
	planToolCall,
	createRichTextToolProvider,
	createSpreadsheetToolProvider,
	createEditorMcpToolProvider,
	EDITOR_MCP_TOOLS,
	type AgentTool,
	type AgentToolProvider,
	type EditorSnapshot
} from '../src/agent';
import { createRichTextPreset, createEditor, SpreadsheetController } from '../src';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

afterEach(() => {
	vi.useRealTimers();
});

const echoTool = (name: string, extra: Partial<AgentTool> = {}): AgentTool => ({
	name,
	description: `${name} tool`,
	inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
	handler: (args, ctx) => ({ tool: ctx.name, provider: ctx.providerId, value: args.value }),
	...extra
});

const provider = (id: string, names: string[], extra: Partial<AgentToolProvider> = {}): AgentToolProvider => ({
	id,
	tools: names.map((n) => echoTool(n)),
	...extra
});

describe('validateJsonSchema', () => {
	const schema = {
		type: 'object',
		properties: {
			name: { type: 'string', minLength: 1, maxLength: 5, pattern: '^[a-z]+$' },
			count: { type: 'integer', minimum: 0, maximum: 10 },
			mode: { enum: ['a', 'b'] },
			tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
			nested: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
			either: { type: ['string', 'null'] },
			fixed: { const: 1 }
		},
		required: ['name'],
		additionalProperties: false
	} as const;

	it('accepts valid input', () => {
		expect(
			validateJsonSchema(
				{ name: 'abc', count: 3, mode: 'a', tags: ['x'], nested: { ok: true }, either: null, fixed: 1 },
				schema
			)
		).toEqual([]);
		// `number` accepts integers; `integer` rejects fractions.
		expect(validateJsonSchema(1, { type: 'number' })).toEqual([]);
		expect(validateJsonSchema(1.5, { type: 'integer' })).toHaveLength(1);
	});

	it('reports every error with a path', () => {
		const errors = validateJsonSchema(
			{ count: 11.5, mode: 'c', tags: [1, 'b', 'c'], nested: {}, either: 3, fixed: 2, extra: true },
			schema
		);
		const paths = errors.map((e) => e.path);
		expect(paths).toEqual(
			expect.arrayContaining(['/name', '/count', '/mode', '/tags', '/tags/0', '/nested/ok', '/either', '/fixed', '/extra'])
		);
		expect(validateJsonSchema({ name: 'ABCDEFG' }, schema).map((e) => e.message)).toEqual([
			'Must be at most 5 characters.',
			'Must match pattern ^[a-z]+$.'
		]);
		expect(validateJsonSchema('x', { type: 'object' })).toEqual([{ path: '/', message: 'Expected object, got string.' }]);
	});
});

describe('ToolRegistry', () => {
	it('lists tools in provider registration order with MCP shapes', () => {
		const registry = new ToolRegistry();
		registry.register(provider('b', ['b1', 'b2']));
		registry.register(provider('a', ['a1']));
		const { tools } = registry.listTools();
		expect(tools.map((t) => t.name)).toEqual(['b__b1', 'b__b2', 'a__a1']);
		expect(tools[0]).toEqual({
			name: 'b__b1',
			description: 'b1 tool',
			inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
		});
		expect(tools[0]).not.toHaveProperty('handler');
		expect(registry.capabilities).toEqual({ tools: { listChanged: true } });
		expect(registry.providerIds()).toEqual(['b', 'a']);
	});

	it('prefixes every tool with its namespace or provider id by default, so names never shift', async () => {
		const registry = new ToolRegistry();
		registry.register(provider('doc-1', ['get_text', 'unique']));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['doc-1__get_text', 'doc-1__unique']);
		registry.register(provider('doc 2', ['get_text'], { title: 'Second doc' }));
		registry.register(provider('p', ['x'], { namespace: 'sheet' }));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['doc-1__get_text', 'doc-1__unique', 'doc_2__get_text', 'sheet__x']);

		// A bare name works when exactly one tool has it, and says which tools it could mean otherwise.
		expect(registry.hasTool('unique')).toBe(true);
		expect(registry.getTool('x')?.name).toBe('sheet__x');
		expect((await registry.callTool('x', { value: 'v' })).structuredContent).toEqual({ tool: 'sheet__x', provider: 'p', value: 'v' });
		expect(registry.hasTool('get_text')).toBe(false);
		const ambiguous = await registry.callTool('get_text');
		expect(ambiguous.isError).toBe(true);
		expect((ambiguous.structuredContent as any).error.code).toBe('unknown_tool');
		expect((ambiguous.content[0] as any).text).toBe(
			'Tool "get_text" is ambiguous: "doc-1__get_text", "doc_2__get_text" all have that name. Call one of them by its full name.'
		);
	});

	it("keeps bare names for namespace: '' unless they collide", () => {
		const registry = new ToolRegistry();
		registry.register(provider('host', ['ping'], { namespace: '' }));
		registry.register(provider('chart', ['get_chart']));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['ping', 'chart__get_chart']);
		registry.register(provider('other', ['ping'], { namespace: '' }));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['host__ping', 'chart__get_chart', 'other__ping']);
	});

	it('groups providers into toolsets by namespace', () => {
		const registry = new ToolRegistry();
		registry.register(provider('image-editor', ['add_layer'], { namespace: 'image', title: 'Image editor', description: 'Layers.', skill: 'pixerate-image-editor' }));
		registry.register(provider('image-effects', ['apply_effect'], { namespace: 'image' }));
		registry.register(provider('chart', ['get_chart']));
		expect(registry.toolsets()).toEqual([
			{
				name: 'image',
				title: 'Image editor',
				description: 'Layers.',
				skill: 'pixerate-image-editor',
				providers: ['image-editor', 'image-effects'],
				tools: ['image__add_layer', 'image__apply_effect']
			},
			{ name: 'chart', providers: ['chart'], tools: ['chart__get_chart'] }
		]);
	});

	it("namespaces colliding tool names by provider id with namespaces: 'on-collision'", async () => {
		const registry = new ToolRegistry({ namespaces: 'on-collision' });
		registry.register(provider('doc-1', ['get_text', 'unique']));
		registry.register(provider('doc 2', ['get_text']));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['doc-1__get_text', 'unique', 'doc_2__get_text']);
		const result = await registry.callTool('doc_2__get_text', { value: 'v' });
		expect(result.structuredContent).toEqual({ tool: 'doc_2__get_text', provider: 'doc 2', value: 'v' });
		expect(registry.hasTool('get_text')).toBe(false);

		// Once the collision goes away the bare name comes back.
		registry.unregister('doc 2');
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['get_text', 'unique']);
	});

	it('always prefixes providers with an explicit namespace', () => {
		const registry = new ToolRegistry();
		registry.register(provider('p', ['x'], { namespace: 'sheet' }));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['sheet__x']);
		expect(() => registry.register(provider('q', ['x'], { namespace: 'sheet' }))).toThrow(ToolRegistryError);
		expect(registry.providerIds()).toEqual(['p']);
	});

	it("throws on collisions with onCollision: 'error' and leaves the registry unchanged", () => {
		const registry = new ToolRegistry({ namespaces: 'on-collision', onCollision: 'error' });
		registry.register(provider('a', ['same']));
		let error: unknown;
		try {
			registry.register(provider('b', ['same']));
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(ToolRegistryError);
		expect((error as ToolRegistryError).code).toBe('name_collision');
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['same']);
	});

	it('rejects duplicate provider ids and invalid tool names', () => {
		const registry = new ToolRegistry();
		registry.register(provider('a', ['x']));
		expect(() => registry.register(provider('a', ['y']))).toThrow(/already registered/);
		expect(() => registry.register(provider('c', ['bad name!']))).toThrow(/Invalid tool name/);
	});

	it('returns structured errors for unknown tools, invalid arguments and handler failures', async () => {
		const registry = new ToolRegistry();
		registry.register({
			id: 'p',
			tools: [
				echoTool('echo', {
					inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
				}),
				echoTool('boom', {
					handler: () => {
						throw new Error('kaboom');
					}
				})
			]
		});

		const unknown = await registry.callTool('nope');
		expect(unknown.isError).toBe(true);
		expect(unknown.structuredContent).toEqual({
			error: {
				code: 'unknown_tool',
				message: 'Unknown tool "nope". List the tools again; the editor that had it may have closed or become read-only.',
				tool: 'nope'
			}
		});

		const invalid = await registry.callTool('echo', { value: 3 });
		expect(invalid.isError).toBe(true);
		expect((invalid.structuredContent as any).error).toMatchObject({
			code: 'invalid_arguments',
			details: [{ path: '/value', message: 'Expected string, got integer.' }]
		});
		expect((invalid.content[0] as any).text).toContain('/value: Expected string');

		const failed = await registry.callTool('boom', {});
		expect((failed.structuredContent as any).error).toMatchObject({ code: 'tool_failed', message: 'kaboom' });

		// Called by its bare name, the handler still sees the exposed name.
		const ok = await registry.callTool('echo', { value: 'hi' });
		expect(ok.isError).toBeUndefined();
		expect(ok.content).toEqual([{ type: 'text', text: JSON.stringify({ tool: 'p__echo', provider: 'p', value: 'hi' }) }]);

		const unchecked = new ToolRegistry({ validateArguments: false });
		unchecked.register(provider('p', ['echo']));
		expect((await unchecked.callTool('echo', { value: 3 })).isError).toBeUndefined();
	});

	it('normalizes handler results', () => {
		expect(toToolResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
		expect(toToolResult(undefined)).toEqual({ content: [] });
		expect(toToolResult([1, 2])).toEqual({ content: [{ type: 'text', text: '[1,2]' }] });
		const full = { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] };
		expect(toToolResult(full)).toBe(full);
	});

	it('coalesces listChanged notifications and skips no-op changes', () => {
		vi.useFakeTimers();
		const registry = createToolRegistry({ listChangedDelayMs: 10 });
		const listener = vi.fn();
		registry.onListChanged(listener);

		const unregisterA = registry.register(provider('a', ['a1']));
		registry.register(provider('b', ['b1']));
		registry.unregister('b');
		expect(listener).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0].map((t: any) => baseToolName(t.name))).toEqual(['a1']);

		// Unmount + remount (e.g. React StrictMode) produces no notification.
		unregisterA();
		unregisterA(); // idempotent
		registry.register(provider('a', ['a1']));
		vi.advanceTimersByTime(10);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('re-reads dynamic providers when they signal a change', () => {
		vi.useFakeTimers();
		const registry = new ToolRegistry();
		let names = ['one'];
		let notify: () => void = () => {};
		const unsubscribe = vi.fn();
		registry.register({
			id: 'dyn',
			tools: () => names.map((n) => echoTool(n)),
			subscribe: (cb) => {
				notify = cb;
				return unsubscribe;
			}
		});
		const listener = vi.fn();
		const off = registry.onListChanged(listener);
		vi.runAllTimers();
		listener.mockClear();

		names = ['one', 'two'];
		notify();
		notify();
		vi.runAllTimers();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['one', 'two']);

		off();
		names = ['three'];
		notify();
		vi.runAllTimers();
		expect(listener).toHaveBeenCalledTimes(1);

		registry.unregister('dyn');
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('flush() delivers pending notifications synchronously and dispose() clears everything', () => {
		const registry = new ToolRegistry({ listChangedDelayMs: 1000 });
		const listener = vi.fn();
		registry.onListChanged(listener);
		registry.register(provider('a', ['a1']));
		registry.flush();
		expect(listener).toHaveBeenCalledTimes(1);
		registry.dispose();
		expect(registry.listTools().tools).toEqual([]);
	});
});

describe('Planner integration with tool calls', () => {
	const snapshot: EditorSnapshot = {
		document: { text: 'Hello' },
		canvas: { nodes: [{ id: 'n1', position: { x: 100, y: 100 }, data: {} }], edges: [] }
	};

	it('maps static MCP tool calls to commands using the schema vocabulary', () => {
		expect(toolCallToAgentCommand('edit_prompt', { operation: 'insert_text', text: 'x', at: 2 })).toEqual({
			type: 'prompt:insert_text',
			text: 'x',
			at: 2
		});
		expect(toolCallToAgentCommand('edit_canvas', { operation: 'connect', source: 'a', target: 'b' })).toMatchObject({
			type: 'canvas:connect'
		});
		expect(toolCallToAgentCommand('edit_canvas', { operation: 'connect', source: 'a' })).toBeNull();
		expect(toolCallToAgentCommand('edit_prompt', { operation: 'bogus' })).toBeNull();

		const steps = planToolCall('edit_canvas', { operation: 'add_node', node: { id: 'n2', data: {} }, nearNodeId: 'n1', side: 'top' }, snapshot);
		expect(steps.map((s) => s.type)).toEqual(['step:canvas_add_node', 'step:canvas_add_edge']);
		expect((steps[0] as any).node.position.y).toBeLessThan(100);
	});

	it('plans registry tools as step:tool_call', () => {
		expect(planToolCall('doc-1__insert_text', { text: 'x' }, snapshot)).toEqual([
			{ type: 'step:tool_call', name: 'doc-1__insert_text', arguments: { text: 'x' } }
		]);
	});

	it('exposes the static tools.ts definitions through a provider', async () => {
		const applied: any[] = [];
		const registry = new ToolRegistry();
		registry.register(
			createEditorMcpToolProvider({
				id: 'studio',
				toolStyle: 'combined',
				getSnapshot: () => snapshot,
				applySteps: (steps) => {
					applied.push(...steps);
				}
			})
		);
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['get_editor_state', 'edit_canvas', 'edit_prompt']);
		expect(registry.getTool('edit_canvas')?.inputSchema).toEqual(EDITOR_MCP_TOOLS[1].inputSchema);

		const state = await registry.callTool('get_editor_state', { includeCanvas: false });
		expect(state.structuredContent).toEqual({ document: { text: 'Hello' } });

		const edit = await registry.callTool('edit_prompt', { operation: 'insert_text', text: 'Hi' });
		expect(edit.structuredContent).toEqual({ applied: 1, steps: ['step:prompt_insert'] });
		expect(applied).toEqual([{ type: 'step:prompt_insert', text: 'Hi', at: undefined }]);

		// Schema validation uses the static enum.
		expect((await registry.callTool('edit_canvas', { operation: 'explode' })).isError).toBe(true);
		const missing = await registry.callTool('edit_canvas', { operation: 'connect', source: 'n1' });
		expect((missing.structuredContent as any).error.code).toBe('tool_failed');
		expect((missing.structuredContent as any).error.message).toBe(
			'Operation "connect" requires source, target; missing: target.'
		);

		const withView = createEditorMcpToolProvider({
			id: 'v',
			getSnapshot: () => snapshot,
			applySteps: () => {},
			captureView: () => ({ data: 'AAA', mimeType: 'image/png' })
		});
		const viewRegistry = new ToolRegistry();
		viewRegistry.register(withView);
		expect((await viewRegistry.callTool('view_editor', {})).content).toEqual([{ type: 'image', data: 'AAA', mimeType: 'image/png' }]);
	});
});

describe('Built-in tool providers', () => {
	it('rich-text provider reads and edits the document literally', async () => {
		const editor = new Editor({ extensions: createRichTextPreset(), content: '<p>Hello world</p>' });
		const registry = new ToolRegistry();
		registry.register(createRichTextToolProvider(editor, { id: 'doc' }));
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual([
			'get_text',
			'find_text',
			'insert_text',
			'replace_text',
			'replace_range',
			'replace_selection',
			'set_selection',
			'edit_table'
		]);

		const text = await registry.callTool('get_text', {});
		expect(text.structuredContent).toMatchObject({ format: 'text', content: 'Hello world' });

		await registry.callTool('insert_text', { text: '<b>!</b>', at: 12 });
		expect(editor.getText()).toBe('Hello world<b>!</b>');

		editor.commands.setTextSelection({ from: 1, to: 6 });
		await registry.callTool('replace_selection', { text: 'Bye\nnew' });
		expect(editor.getHTML()).toBe('<p>Bye</p><p>new world&lt;b&gt;!&lt;/b&gt;</p>');

		const html = await registry.callTool('get_text', { format: 'html' });
		expect((html.structuredContent as any).content).toContain('<p>Bye</p>');
		expect((await registry.callTool('get_text', { format: 'rtf' })).isError).toBe(true);
		const outside = await registry.callTool('insert_text', { text: 'x', at: 9999 });
		expect((outside.structuredContent as any).error.message).toMatch(/outside the document/);
		editor.destroy();
	});

	it('rich-text provider announces editability changes and destruction', () => {
		vi.useFakeTimers();
		const controller = createEditor({ extensions: createRichTextPreset(), content: 'x' });
		const registry = new ToolRegistry();
		const listener = vi.fn();
		registry.onListChanged(listener);
		registry.register(createRichTextToolProvider(controller, { id: 'doc' }));
		vi.runAllTimers();
		listener.mockClear();

		// Content edits don't change the tool list, so nothing is announced.
		controller.insertText('more');
		vi.runAllTimers();
		expect(listener).not.toHaveBeenCalled();

		controller.editor.setEditable(false);
		vi.runAllTimers();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['get_text', 'find_text']);

		controller.destroy();
		vi.runAllTimers();
		expect(listener).toHaveBeenCalledTimes(2);
		expect(registry.listTools().tools).toEqual([]);
	});

	it('spreadsheet provider reads ranges and sets cells through the controller', async () => {
		const sheet = new SpreadsheetController();
		const registry = new ToolRegistry();
		registry.register(createSpreadsheetToolProvider(sheet, { id: 'sheet', namespace: 'sheet' }));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual([
			'sheet__get_range',
			'sheet__set_cell',
			'sheet__set_range',
			'sheet__insert_rows',
			'sheet__delete_rows',
			'sheet__insert_columns',
			'sheet__delete_columns',
			'sheet__merge_cells',
			'sheet__unmerge_cells',
			'sheet__transpose_range'
		]);

		await registry.callTool('sheet__set_cell', { cell: 'A1', value: 2 });
		await registry.callTool('sheet__set_cell', { cell: 'b1', value: '=A1*21' });
		const set = await registry.callTool('sheet__set_cell', { cell: 'C1', value: '=1/0' });
		expect(set.structuredContent).toMatchObject({ cell: 'C1', raw: '=1/0' });

		const range = await registry.callTool('sheet__get_range', { range: 'A1:C2' });
		expect(range.structuredContent).toMatchObject({
			range: 'A1:C2',
			raw: [['2', '=A1*21', '=1/0'], ['', '', '']],
			sheet: { rows: 10, columns: 4 }
		});
		const values = (range.structuredContent as any).values;
		expect(Number(values[0][1])).toBe(42);
		expect((range.structuredContent as any).errors).toEqual([{ cell: 'C1', error: values[0][2] }]);

		expect((await registry.callTool('sheet__get_range', { range: 'nope' })).isError).toBe(true);
		const outside = await registry.callTool('sheet__set_cell', { cell: 'Z99', value: 'x' });
		expect((outside.structuredContent as any).error.message).toMatch(/outside the sheet/);
	});
});
