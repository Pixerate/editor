import { describe, expect, it } from 'vitest';
import { VectorEditorController, createVectorCommands, rectSubpath, type VectorPathNode } from '../src/vector';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';

const square = (id: string): VectorPathNode => ({ id, type: 'path', name: 'Rectangle', fill: '#ff0000', subpaths: [rectSubpath({ x: 0, y: 0, width: 20, height: 20 })] });

function setup() {
	const controller = new VectorEditorController({ document: { width: 100, height: 100, nodes: [square('a')] } });
	const commands = new CommandRegistry({ context: undefined });
	commands.register(createVectorCommands(controller));
	const tools = new ToolRegistry();
	tools.register(createCommandToolProvider(commands));
	const run = async (id: string, params: Record<string, unknown> = {}) => {
		const r = await tools.callTool('run_command', { id, params });
		const sc = r.structuredContent as { result?: any; error?: { message: string } };
		return { ok: !r.isError, result: sc.result, message: sc.error?.message };
	};
	return { controller, run };
}

describe('vector.rename', () => {
	it('renames a layer in one undo step', async () => {
		const { controller, run } = setup();
		expect(await run('vector.rename', { id: 'a', name: 'Sun disc' })).toMatchObject({ ok: true, result: { id: 'a', name: 'Sun disc' } });
		expect(controller.getNode('a')?.name).toBe('Sun disc');
		controller.undo();
		expect(controller.getNode('a')?.name).toBe('Rectangle');
	});

	it('fails usefully on an unknown node or an empty name', async () => {
		const { controller, run } = setup();
		expect(await run('vector.rename', { id: 'nope', name: 'X' })).toMatchObject({ ok: false, message: expect.stringMatching(/no node "nope"/) });
		expect((await run('vector.rename', { id: 'a', name: '' })).ok).toBe(false);
		expect(controller.getNode('a')?.name).toBe('Rectangle');
	});
});
