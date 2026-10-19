import { describe, it, expect, beforeAll, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import {
	ToolRegistry,
	createRichTextToolProvider,
	createSpreadsheetToolProvider,
	createEditorMcpToolProvider,
	createCanvasComponentToolProvider,
	type AgentToolProvider
} from '../src/agent';
import { CommandRegistry, createCommandToolProvider, createHistoryCommands } from '../src/commands';
import { HistoryManager } from '../src/history';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
import { createGenerationToolProvider, createGenerationHistoryToolProvider, createGenerationRecordStore } from '../src/generation';
import { createMemoryStorage } from '../src/persistence';
import { ChartController, createChartToolProvider, createOfficeChartToolProvider } from '../src/chart';
import { DiagramController, createDiagramToolProvider } from '../src/diagram';
import { AnimationEditorController, createAnimationEditorToolProvider } from '../src/animation-editor';
import { VideoEditorController, createVideoEditorToolProvider } from '../src/video-editor';
import { createRichTextPreset, SpreadsheetController } from '../src';
import { createCaptureToolProvider, createElementCaptureSurface } from '../src/tools';
import { createCanvasCaptureToolProvider } from '../src/canvas';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

function setup() {
	const commands = new CommandRegistry<{ value: number }>({ context: { value: 0 } });
	const history = new HistoryManager();
	commands.register(createHistoryCommands(history));
	commands.register([
		{
			id: 'counter.set',
			label: 'Set Counter',
			group: 'Counter',
			shortcut: 'Mod+Shift+S',
			params: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
			run: (ctx, params: { value: number }) => {
				ctx.value = params.value;
				return { value: ctx.value };
			}
		},
		{ id: 'counter.fail', label: 'Fail', run: () => { throw new Error('kaput'); } },
		{ id: 'counter.hidden', label: 'Hidden', hidden: true, run: () => 'secret' }
	]);
	const tools = new ToolRegistry();
	tools.register(createCommandToolProvider(commands));
	return { commands, tools, history };
}

describe('createCommandToolProvider', () => {
	it('lists commands with params, shortcuts and disabled reasons', async () => {
		const { tools } = setup();
		expect(tools.listTools().tools.map((t) => t.name)).toEqual(['list_commands', 'run_command', 'run_commands']);
		const result = await tools.callTool('list_commands', {});
		const listed = (result.structuredContent as any).commands;
		expect(listed.map((c: any) => c.id)).toEqual(['history.undo', 'history.redo', 'counter.set', 'counter.fail']);
		expect(listed[0]).toMatchObject({ enabled: false, disabledReason: 'Nothing to undo.' });
		expect(listed[2]).toMatchObject({ shortcuts: ['Mod+Shift+S'], params: { required: ['value'] } });
		const filtered = await tools.callTool('list_commands', { query: 'counter', enabledOnly: true });
		expect((filtered.structuredContent as any).commands.map((c: any) => c.id)).toEqual(['counter.set', 'counter.fail']);
	});

	it('rejects unknown tool arguments and unknown command params naming accepted keys', async () => {
		const { tools } = setup();
		const badArg = await tools.callTool('list_commands', { filter: 'x' });
		expect(badArg.isError).toBe(true);
		expect((badArg.structuredContent as any).error.code).toBe('invalid_arguments');

		const badParam = await tools.callTool('run_command', { id: 'counter.set', params: { value: 1, extra: true } });
		expect(badParam.isError).toBe(true);
		expect((badParam.structuredContent as any).error).toEqual({
			code: 'invalid_params',
			command: 'counter.set',
			message: 'Unknown parameter "extra" for command "counter.set"; expected "value".'
		});

		const unknown = await tools.callTool('run_command', { id: 'nope' });
		expect((unknown.structuredContent as any).error.code).toBe('invalid_arguments');
	});

	it('runs commands and reports disabled and failing ones', async () => {
		const { tools, commands } = setup();
		const ok = await tools.callTool('run_command', { id: 'counter.set', params: { value: 5 } });
		expect(ok.isError).toBeUndefined();
		expect(ok.structuredContent).toEqual({ id: 'counter.set', ok: true, result: { value: 5 } });
		expect(commands.context.value).toBe(5);

		const disabled = await tools.callTool('run_command', { id: 'history.undo' });
		expect(disabled.isError).toBe(true);
		expect((disabled.structuredContent as any).error).toMatchObject({ code: 'disabled', message: 'Nothing to undo.' });

		const failed = await tools.callTool('run_command', { id: 'counter.fail' });
		expect((failed.structuredContent as any).error).toMatchObject({ code: 'failed', message: 'kaput' });
	});

	it('runs batches in order, stopping at the first error by default', async () => {
		const { tools, commands } = setup();
		const stopped = await tools.callTool('run_commands', {
			steps: [{ id: 'counter.set', params: { value: 1 } }, { id: 'counter.fail' }, { id: 'counter.set', params: { value: 2 } }]
		});
		expect(stopped.isError).toBe(true);
		expect(stopped.structuredContent).toMatchObject({ completed: 1, failed: 1, skipped: 1 });
		expect(commands.context.value).toBe(1);

		const continued = await tools.callTool('run_commands', {
			steps: [{ id: 'counter.hidden' }, { id: 'missing' }, { id: 'counter.set', params: { value: 3 } }],
			stopOnError: false
		});
		expect(continued.structuredContent).toMatchObject({
			completed: 1,
			failed: 2,
			results: [
				{ id: 'counter.hidden', ok: false, code: 'unknown_command' },
				{ id: 'missing', ok: false, code: 'unknown_command' },
				{ id: 'counter.set', ok: true, result: { value: 3 } }
			]
		});
		expect(commands.context.value).toBe(3);

		const allOk = await tools.callTool('run_commands', { steps: [{ id: 'counter.set', params: { value: 4 } }] });
		expect(allOk.isError).toBeUndefined();
		expect(allOk.structuredContent).toMatchObject({ completed: 1, failed: 0 });
	});

	it('announces listChanged when commands are added or removed, not when they run', () => {
		const { tools, commands } = setup();
		tools.flush(); // the registration itself
		const listener = vi.fn();
		tools.onListChanged(listener);
		commands.execute('counter.set', { value: 9 });
		tools.flush();
		expect(listener).not.toHaveBeenCalled();
		const remove = commands.register({ id: 'counter.new', label: 'New', run: () => {} });
		tools.flush();
		expect(listener).toHaveBeenCalledTimes(1);
		expect((tools.getTool('run_command')!.inputSchema.properties!.id as any).enum).toContain('counter.new');
		remove();
		tools.flush();
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('supports scopes, exclusions and namespaces', async () => {
		const commands = new CommandRegistry();
		commands.register([
			{ id: 'a', label: 'A', run: () => 'a' },
			{ id: 'b', label: 'B', scope: 'canvas', run: () => 'b' },
			{ id: 'c', label: 'C', scope: 'sheet', run: () => 'c' }
		]);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands, { id: 'cmd', namespace: 'app', scope: 'canvas', exclude: (id) => id === 'a' }));
		const listed = await tools.callTool('app__list_commands', {});
		expect((listed.structuredContent as any).commands.map((c: any) => c.id)).toEqual(['b']);
		const blocked = await tools.callTool('app__run_commands', { steps: [{ id: 'c' }] });
		expect((blocked.structuredContent as any).results[0].code).toBe('unknown_command');
	});
});

describe('built-in tool providers have complete MCP annotations', () => {
	it('every tool has a title and all four hints', () => {
		const editor = new Editor({ extensions: createRichTextPreset(), content: '<p>x</p>' });
		const sheet = new SpreadsheetController({
			document: {
				columns: [{ id: 'c0', key: 'A', title: 'A', type: 'freeform' as const }],
				rows: [{ id: 'r0', index: 0, type: 'freeform' as const }]
			}
		});
		const providers: AgentToolProvider[] = [
			createRichTextToolProvider(editor, { id: 'doc' }),
			createSpreadsheetToolProvider(sheet, { id: 'sheet' }),
			createEditorMcpToolProvider({
				id: 'editor',
				getSnapshot: () => ({}) as any,
				applySteps: () => {},
				captureView: () => ({ data: '', mimeType: 'image/png' })
			}),
			createCommandToolProvider(new CommandRegistry()),
			// Only the tool list is read, so a stub controller with the variant methods will do.
			createCanvasComponentToolProvider({ addVariant: () => {}, removeVariant: () => {} } as any)
		];
		const registry = new ToolRegistry();
		providers.forEach((p) => registry.register(p));
		const tools = registry.listTools().tools;
		// rich text 8, spreadsheet 10, editor (state + 7 canvas + 4 prompt + view) 13, commands 3, components 17
		expect(tools.length).toBe(8 + 10 + 13 + 3 + 17);
		// Hosts with their own tool sets: checked to the same standard.
		registry.register(createImageEditorToolProvider(new ImageEditorController(), { id: 'img', namespace: 'img' }));
		registry.register(createCanvasCaptureToolProvider({ id: 'capture', namespace: 'capture', element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => [] }));
		registry.register(createCaptureToolProvider(createElementCaptureSurface({ element: null }), { id: 'dom-capture', namespace: 'dom' }));
		registry.register(createChartToolProvider(new ChartController(), { id: 'chart', namespace: 'chart' }));
		registry.register(createDiagramToolProvider(new DiagramController(), { id: 'diagram', namespace: 'diagram', renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) }));
		registry.register(createAnimationEditorToolProvider(new AnimationEditorController(), { id: 'animation', namespace: 'animation' }));
		registry.register(createVideoEditorToolProvider(new VideoEditorController(), { id: 'video', namespace: 'video' }));
		registry.register(createOfficeChartToolProvider({ id: 'office', namespace: 'office', files: () => [], controller: new ChartController() }));
		registry.register(createOfficeChartToolProvider({ id: 'office-data', namespace: 'officedata' }));
		const chartDoc = new Editor({ extensions: createRichTextPreset({ chart: true }), content: '<p>x</p>' });
		registry.register(createRichTextToolProvider(chartDoc, { id: 'chart-doc', namespace: 'chartdoc' }));
		registry.register(
			createGenerationToolProvider({ namespace: 'gen', models: [], generate: () => ({}), estimate: () => ({}) })
		);
		registry.register(
			createGenerationHistoryToolProvider({ namespace: 'genhistory', store: createGenerationRecordStore({ storage: createMemoryStorage() }) })
		);
		const allTools = registry.listTools().tools;
		expect(allTools.length).toBeGreaterThan(tools.length);
		const undescribed: string[] = [];
		for (const tool of allTools) {
			expect(typeof tool.title, `${tool.name} title`).toBe('string');
			expect(tool.annotations?.title, `${tool.name} annotations.title`).toBe(tool.title);
			for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
				expect(typeof tool.annotations?.[hint], `${tool.name} lacks ${hint}`).toBe('boolean');
			}
			// A read-only tool is never destructive.
			if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
			// Every argument is described, so a model knows what to pass.
			expect(tool.description, `${tool.name} description`).toBeTruthy();
			for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
				if (!(prop as any).description) undescribed.push(`${tool.name}.${key}`);
			}
		}
		expect(undescribed).toEqual([]);
		expect(allTools.map((t) => t.name)).toEqual(expect.arrayContaining(['diagram__get_diagram', 'diagram__add_diagram_node', 'diagram__render_diagram', 'animation__get_animation', 'animation__add_commands', 'animation__export_flair_effect', 'video__get_video_project', 'video__list_video_sequences', 'video__add_video_clip', 'video__export_video_ffmpeg', 'video__get_video_scopes', 'video__set_video_lut', 'video__remove_video_lut', 'video__plan_video_proxies', 'video__set_video_proxies', 'video__set_video_preview_scale', 'video__get_video_preview_cache', 'video__set_video_keyframes', 'video__remove_video_keyframes', 'video__slip_video_clip', 'video__roll_video_edit', 'video__slide_video_clip', 'video__lift_video_range', 'video__extract_video_range', 'video__split_video_at', 'capture__capture_view', 'dom__capture_view', 'img__capture_view', 'chartdoc__insert_chart', 'chartdoc__update_chart_in_document', 'chartdoc__list_document_charts', 'chartdoc__insert_sparkline']));
		editor.destroy();
		chartDoc.destroy();
	});
});
