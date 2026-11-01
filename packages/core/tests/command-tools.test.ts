import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { CommandRegistry, createCommandToolProvider, createDrawCommands, createHistoryCommands } from '../src/commands';
import { HistoryManager } from '../src/history';
import { ImageEditorController, createImageEditorDocument, createImageEditorToolProvider, createImageEffectsToolProvider } from '../src/image-editor';
import { createGenerationToolProvider, createGenerationHistoryToolProvider, createGenerationRecordStore } from '../src/generation';
import { createDocumentToolProvider, createEditorDocumentStore, createMemoryStorage } from '../src/persistence';
import { ParametersController, createParametersEditorDocument } from '../src/parameters';
import { TokenStore, createTokensEditorDocument } from '../src/tokens';
import { createSpreadsheetEditorDocument } from '../src/spreadsheet';
import { ChartController, createChartEditorDocument, createChartToolProvider, createOfficeChartToolProvider } from '../src/chart';
import { DiagramController, createDiagramEditorDocument, createDiagramToolProvider } from '../src/diagram';
import { AnimationEditorController, createAnimationEditorDocument, createAnimationEditorToolProvider, createAnimationEffectsToolProvider } from '../src/animation-editor';
import { VideoEditorController, createVideoEditorDocument, createVideoEditorToolProvider, createVideoEffectsToolProvider, createVideoDialogueToolProvider, createVideoMusicToolProvider } from '../src/video-editor';
import { createEffectAuthoringToolProvider, createFakeEffectProvider } from '../src/effects';
import { VectorEditorController, createVectorEditorDocument, createVectorEffectsToolProvider, createVectorGenerationToolProvider } from '../src/vector';
import { createRichTextPreset, createRichTextEditorDocument, SpreadsheetController } from '../src';
import { createAgentPlayback, createCaptureToolProvider, createElementCaptureSurface, createPlaybackToolProvider } from '../src/tools';
import { canvasExplosionToolTarget, createCanvasCaptureToolProvider, createCanvasEditorDocument, createCanvasEffectsController, createCanvasEffectsToolProvider, createCanvasExplosionStateController, createCanvasExplosionToolProvider } from '../src/canvas';
import { PaintEditorController, createPaintEditorDocument, createPaintEditorToolProvider, createPaintEffectsToolProvider } from '../src/paint-editor';
import { createColorToolProvider } from '../src/color';
import { createStyleResolver, createStyleToolProvider, memoryStyleStore } from '../src/tools';
import { chartStyleDomain, createChartStyleToolProvider } from '../src/chart';
import { createTokensStyleToolProvider, tokensStyleDomain } from '../src/tokens';
import { createTypographyToolProvider, createFontPickerToolProvider, FontPickerModel } from '../src/typography';
import { GradientController, createGradientToolProvider } from '../src/gradient';
import { baseToolName } from '../src/tools';

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
		expect(tools.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['list_commands', 'run_command', 'run_commands']);
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
		// rich text 11 (8 + 3 formatting), spreadsheet 10, editor (state + 7 canvas + 4 prompt + view) 13, commands 3, components 17
		expect(tools.length).toBe(11 + 10 + 13 + 3 + 17);
		// Hosts with their own tool sets: checked to the same standard.
		registry.register(createImageEditorToolProvider(new ImageEditorController(), { id: 'img', namespace: 'img' }));
		registry.register(createCanvasEffectsToolProvider(createCanvasEffectsController({ getNodes: () => [], setNodes: () => {}, effects: createFakeEffectProvider() }), { id: 'canvas-effects', namespace: 'canvasfx' }));
		registry.register(createImageEffectsToolProvider(new ImageEditorController({ effects: createFakeEffectProvider() }), { id: 'img-effects', namespace: 'imgfx' }));
		registry.register(createPaintEditorToolProvider(new PaintEditorController({ width: 64, height: 64 }), { id: 'paint', namespace: 'paint' }));
		{
			const painter = new PaintEditorController({ width: 64, height: 64 });
			painter.setEffectsProvider(createFakeEffectProvider());
			registry.register(createPaintEffectsToolProvider(painter, { id: 'paint-effects', namespace: 'paintfx' }));
		}
		registry.register(createCanvasExplosionToolProvider(canvasExplosionToolTarget(createCanvasExplosionStateController(), { getNodes: () => [] }), { namespace: 'explosion' }));
		registry.register(createCanvasCaptureToolProvider({ id: 'capture', namespace: 'capture', element: null, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodes: () => [] }));
		registry.register(createCaptureToolProvider(createElementCaptureSurface({ element: null }), { id: 'dom-capture', namespace: 'dom' }));
		registry.register(createPlaybackToolProvider(createAgentPlayback()));
		registry.register(createChartToolProvider(new ChartController(), { id: 'chart', namespace: 'chart' }));
		registry.register(createDiagramToolProvider(new DiagramController(), { id: 'diagram', namespace: 'diagram', renderSvg: () => ({ svg: '<svg/>', width: 1, height: 1 }) }));
		registry.register(
			createDocumentToolProvider(createDiagramEditorDocument(new DiagramController()), {
				namespace: 'diagramdoc',
				skill: 'pixerate-diagram',
				store: createEditorDocumentStore({ storage: createMemoryStorage() })
			})
		);
		for (const [doc, skill] of [
			[createChartEditorDocument(new ChartController()), 'pixerate-chart'],
			[createAnimationEditorDocument(new AnimationEditorController()), 'pixerate-animation-editor'],
			[createVideoEditorDocument(new VideoEditorController()), 'pixerate-video-editor'],
			[createParametersEditorDocument(new ParametersController({ schema: { fields: [] } })), 'pixerate-parameters'],
			[createVectorEditorDocument(new VectorEditorController()), 'pixerate-vector'],
			[createSpreadsheetEditorDocument(sheet), 'pixerate-spreadsheet'],
			[createRichTextEditorDocument(editor), 'pixerate-rich-text'],
			[createTokensEditorDocument(new TokenStore()), 'pixerate-tokens'],
			[createCanvasEditorDocument({ getNodes: () => [], setNodes: () => {}, getEdges: () => [], setEdges: () => {}, history: new HistoryManager() }), 'pixerate-canvas'],
			[createImageEditorDocument(new ImageEditorController()), 'pixerate-image-editor'],
			[createPaintEditorDocument(new PaintEditorController({ width: 64, height: 64 })), 'pixerate-paint-editor']
		] as const) {
			registry.register(createDocumentToolProvider(doc, { namespace: `${doc.kind}doc`, skill, store: createEditorDocumentStore({ storage: createMemoryStorage() }) }));
		}
		registry.register(createAnimationEditorToolProvider(new AnimationEditorController(), { id: 'animation', namespace: 'animation' }));
		registry.register(createVectorEffectsToolProvider(new VectorEditorController(), { id: 'vector-effects', namespace: 'vecfx' }));
		registry.register(createVectorGenerationToolProvider(new VectorEditorController(), { id: 'vector-generation', namespace: 'vecgen', models: [{ id: 'm', media: 'image' }], generate: () => ({ svg: '' }) }));
		registry.register(createAnimationEffectsToolProvider(new AnimationEditorController({ effects: createFakeEffectProvider() }), { id: 'animation-effects', namespace: 'animfx' }));
		registry.register(createVideoEditorToolProvider(new VideoEditorController(), { id: 'video', namespace: 'video' }));
		registry.register(createVideoEffectsToolProvider(new VideoEditorController({ effects: createFakeEffectProvider() }), { id: 'video-effects', namespace: 'videofx' }));
		registry.register(createVideoDialogueToolProvider(new VideoEditorController(), { id: 'video-dialogue', namespace: 'videodialogue' }));
		registry.register(createVideoMusicToolProvider(new VideoEditorController(), { id: 'video-music', namespace: 'videomusic' }));
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
		registry.register(createColorToolProvider({ id: 'color', namespace: 'color' }));
		{
			const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore() }], domains: [chartStyleDomain, tokensStyleDomain] });
			registry.register(createStyleToolProvider(styles));
			registry.register(createChartStyleToolProvider(new ChartController(), styles, { namespace: 'chartstyle' }));
			registry.register(createTokensStyleToolProvider(new TokenStore(), styles, { namespace: 'tokenstyle' }));
		}
		{
			// Commands listed as tools of their own (the canvas gestures and listBrushes).
			const drawCommands = new CommandRegistry();
			drawCommands.register(createDrawCommands({ drawStroke: async () => ({ id: 'n', bounds: { x: 0, y: 0, width: 1, height: 1 } }), listBrushes: async () => [] }));
			registry.register(createCommandToolProvider(drawCommands, { id: 'draw', namespace: 'draw', tools: (id) => id !== 'canvas.drawFreehand' }));
		}
		registry.register(createGradientToolProvider(new GradientController(), { id: 'gradient', namespace: 'gradient' }));
		registry.register(createTypographyToolProvider({ id: 'typography', namespace: 'typography' }));
		registry.register(createFontPickerToolProvider(new FontPickerModel(), { id: 'font-picker', namespace: 'fontpicker' }));
		{
			const authoringSession = createFakeEffectProvider().openAuthoring!({ effectId: 'fake.invert' }) as any;
			authoringSession.setSource = async () => ({ ok: true, issues: [] });
			registry.register(
				createEffectAuthoringToolProvider(
					{
						session: () => authoringSession,
						capture: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
					},
					{ id: 'effect-authoring', namespace: 'fxauth' }
				)
			);
		}
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
		// Every toolset says what it is and which skill documents it, for list_toolsets and search_tools.
		const skillsDir = join(__dirname, '..', 'skills');
		for (const set of registry.toolsets()) {
			expect(set.title, `${set.name} title`).toBeTruthy();
			expect(set.description, `${set.name} description`).toMatch(/^[A-Z].*\.$/);
			if (set.name !== 'dom') expect(existsSync(join(skillsDir, set.skill ?? '-', 'SKILL.md')), `${set.name} skill ${set.skill}`).toBe(true);
		}
		expect(allTools.map((t) => t.name)).toEqual(expect.arrayContaining(['diagram__get_diagram', 'diagram__add_diagram_node', 'diagram__render_diagram', 'animation__get_animation', 'animation__add_commands', 'animation__export_flair_effect', 'video__get_video_project', 'video__list_video_sequences', 'video__add_video_clip', 'video__export_video_ffmpeg', 'video__get_video_scopes', 'video__set_video_lut', 'video__remove_video_lut', 'video__plan_video_proxies', 'video__set_video_proxies', 'video__set_video_preview_scale', 'video__get_video_preview_cache', 'video__set_video_keyframes', 'video__remove_video_keyframes', 'video__slip_video_clip', 'video__roll_video_edit', 'video__slide_video_clip', 'video__lift_video_range', 'video__extract_video_range', 'video__split_video_at', 'video__add_video_adjustment_clip', 'video__set_video_clip_mask', 'video__remove_video_clip_mask', 'video__set_video_skin_protection', 'video__plan_video_edits', 'video__list_video_edit_plans', 'video__apply_video_edit_plan', 'video__discard_video_edit_plan', 'videodialogue__find_video_disfluencies', 'videodialogue__plan_video_dialogue_cleanup', 'videomusic__find_video_beats', 'videomusic__plan_video_beat_snap', 'videomusic__duck_video_music', 'videomusic__measure_video_loudness', 'videomusic__normalize_video_loudness', 'videofx__search_effects', 'animfx__add_vector_effect', 'imgfx__apply_effect', 'imgfx__add_effect_layer', 'videofx__apply_effect', 'videofx__add_video_effect_clip', 'videofx__set_video_effect_transition', 'capture__capture_view', 'dom__capture_view', 'img__capture_view', 'paint__paint_stroke', 'paint__set_paper', 'paint__list_brushes', 'paint__render_preview', 'chartdoc__insert_chart', 'chartdoc__update_chart_in_document', 'chartdoc__list_document_charts', 'chartdoc__insert_sparkline', 'typography__list_fonts', 'typography__check_typography_accessibility', 'typography__segment_text', 'fontpicker__set_font_selection', 'explosion__list_explodable_nodes', 'explosion__explode_node', 'explosion__collapse_node', 'imagedoc__find_unreferenced_image_assets', 'imagedoc__delete_unreferenced_image_assets', 'paintdoc__find_unreferenced_paint_assets', 'paintdoc__delete_unreferenced_paint_assets']));
		editor.destroy();
		chartDoc.destroy();
	});
});
