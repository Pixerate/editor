import { describe, it, expect } from 'vitest';
import {
	planAgentCommand,
	EDITOR_MCP_TOOLS,
	MCP_TOOL_GET_EDITOR_STATE,
	MCP_TOOL_EDIT_CANVAS,
	MCP_TOOL_EDIT_PROMPT,
	type CanvasNode,
	type CanvasEdge,
	type EditorSnapshot
} from '../src/agent';

describe('Agent Command Planner', () => {
	const initialSnapshot: EditorSnapshot = {
		document: {
			text: 'Hello {{name}}',
			variables: { name: 'World' },
			selection: { from: 0, to: 5 }
		},
		canvas: {
			nodes: [
				{ id: 'node-1', position: { x: 100, y: 100 }, width: 200, height: 60, data: { label: 'Start' } }
			],
			edges: []
		}
	};

	it('plans canvas:add_node with collision-avoidance beside existing node', () => {
		const steps = planAgentCommand(
			{
				type: 'canvas:add_node',
				node: { id: 'node-2', data: { label: 'Next' } },
				nearNodeId: 'node-1',
				side: 'right'
			},
			initialSnapshot
		);

		expect(steps).toHaveLength(2);
		expect(steps[0].type).toBe('step:canvas_add_node');
		if (steps[0].type === 'step:canvas_add_node') {
			expect(steps[0].node.id).toBe('node-2');
			expect(steps[0].node.position.x).toBeGreaterThan(100);
		}
		expect(steps[1].type).toBe('step:canvas_add_edge');
		if (steps[1].type === 'step:canvas_add_edge') {
			expect(steps[1].edge.source).toBe('node-1');
			expect(steps[1].edge.target).toBe('node-2');
		}
	});

	it('plans canvas:layout with incremental preservation', () => {
		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 500, y: 200 }, data: {} },
			{ id: '2', position: { x: 0, y: 0 }, data: {} }
		];
		const edges: CanvasEdge[] = [{ id: 'e1', source: '1', target: '2' }];

		const steps = planAgentCommand(
			{
				type: 'canvas:layout',
				direction: 'LR',
				incremental: true
			},
			{ canvas: { nodes, edges } }
		);

		expect(steps).toHaveLength(1);
		expect(steps[0].type).toBe('step:canvas_move_nodes');
		if (steps[0].type === 'step:canvas_move_nodes') {
			expect(steps[0].positions['1']).toEqual({ x: 500, y: 200 });
			expect(steps[0].positions['2'].x).toBeGreaterThan(500);
		}
	});

	it('plans prompt commands (insert, replace, set variable)', () => {
		const insertSteps = planAgentCommand(
			{ type: 'prompt:insert_text', text: ' extra', at: 5 },
			initialSnapshot
		);
		expect(insertSteps[0]).toEqual({
			type: 'step:prompt_insert',
			text: ' extra',
			at: 5
		});

		const replaceSteps = planAgentCommand(
			{ type: 'prompt:replace_range', from: 0, to: 5, text: 'Hi' },
			initialSnapshot
		);
		expect(replaceSteps[0]).toEqual({
			type: 'step:prompt_replace',
			from: 0,
			to: 5,
			text: 'Hi'
		});

		const varSteps = planAgentCommand(
			{ type: 'prompt:set_variable', name: 'user', value: 'Alice' },
			initialSnapshot
		);
		expect(varSteps[0]).toEqual({
			type: 'step:prompt_set_variable',
			name: 'user',
			value: 'Alice'
		});

		const saySteps = planAgentCommand(
			{ type: 'choreography:say', text: 'Connecting nodes...', atNodeId: 'node-1' },
			initialSnapshot
		);
		expect(saySteps[0]).toEqual({
			type: 'step:say',
			text: 'Connecting nodes...',
			atNodeId: 'node-1',
			position: undefined
		});

		const waitSteps = planAgentCommand(
			{ type: 'choreography:wait', ms: 500 },
			initialSnapshot
		);
		expect(waitSteps[0]).toEqual({
			type: 'step:wait',
			ms: 500
		});
	});
});

describe('Agent MCP Tool Definitions', () => {
	it('exports valid MCP tool definitions with schemas', () => {
		expect(EDITOR_MCP_TOOLS).toHaveLength(4);
		expect(MCP_TOOL_GET_EDITOR_STATE.name).toBe('get_editor_state');
		expect(MCP_TOOL_EDIT_CANVAS.name).toBe('edit_canvas');
		expect(MCP_TOOL_EDIT_PROMPT.name).toBe('edit_prompt');

		const viewTool = EDITOR_MCP_TOOLS.find((t) => t.name === 'view_editor');
		expect(viewTool).toBeDefined();
		expect(viewTool?.inputSchema.properties.scope.enum).toContain('viewport');
		expect(viewTool?.inputSchema.properties.scope.enum).toContain('canvas');

		expect(MCP_TOOL_EDIT_CANVAS.inputSchema.properties.operation.enum).toContain('add_node');
		expect(MCP_TOOL_EDIT_CANVAS.inputSchema.properties.operation.enum).toContain('layout');
		expect(MCP_TOOL_EDIT_PROMPT.inputSchema.properties.operation.enum).toContain('insert_text');
	});
});

