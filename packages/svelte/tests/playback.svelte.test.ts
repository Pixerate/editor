import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry, PresenceStore, createAgentPlayback, createInstantPresenceClock } from '@pixerate/editor/tools';
import { createEditorMcpToolProvider, type AgentStep } from '@pixerate/editor/agent';
import type { CanvasNode } from '@pixerate/editor/canvas';
import { PresenceLayer } from '../src';
import CanvasPlaybackProbe from './fixtures/CanvasPlaybackProbe.svelte';

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

function render(component: any, props: Record<string, any>) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(component, { target, props });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		target.remove();
	});
	return { target, destroy: () => unmount(instance) };
}

describe('PresenceLayer (Svelte)', () => {
	it('draws each actor at its viewport position with its note and focus ring', () => {
		const presence = new PresenceStore();
		const { target } = render(PresenceLayer, { presence, viewport: { x: 10, y: 20, zoom: 2 } });
		expect(target.querySelector('.pixerate-presence')).toBeNull();
		presence.set({ id: 'a', name: 'Agent', color: '#7c3aed', x: 5, y: 5, message: 'Aligning', focus: { x: 0, y: 0, width: 10, height: 10 } });
		flushSync();
		const layer = target.querySelector('.pixerate-presence')!;
		expect((layer.querySelector('[data-actor="a"]') as HTMLElement).style.transform).toBe('translate(20px, 30px)');
		expect(layer.querySelector('[data-actor-message="a"]')!.textContent).toBe('Aligning');
		const ring = layer.querySelector('[data-actor-focus="a"]') as HTMLElement;
		expect([ring.style.left, ring.style.width]).toEqual(['6px', '28px']);
	});
});

describe('createCanvasPlaybackSurface', () => {
	it('plays canvas tool calls on the flow, maps through the viewport and detaches on destroy', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' }, width: 100, height: 40 }];
		const provider = createEditorMcpToolProvider({
			id: 'canvas',
			surfaces: { canvas: true, prompt: false },
			getSnapshot: () => ({ canvas: { nodes, edges: [] } }),
			applySteps: (steps: AgentStep[]) => {
				for (const s of steps) if (s.type === 'step:canvas_select') nodes = nodes.map((n) => ({ ...n, selected: s.nodeIds.includes(n.id) }));
			}
		});
		const { target, destroy } = render(CanvasPlaybackProbe, { playback, registry, provider, getNodes: () => nodes });
		expect(playback.surface('canvas')).toBeTruthy();
		const steps = playback.record();
		const result = await registry.callTool('canvas__canvas_select', { nodeIds: ['a'] });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(nodes[0]!.selected).toBe(true);
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'commit']);
		expect((target.querySelector('[data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 40px)');
		destroy();
		cleanups = [];
		target.remove();
		expect(playback.surface('canvas')).toBeUndefined();
	});
});

describe('VectorCanvas playback (Svelte)', () => {
	it('plays vector commands with the cursor in document units through the viewport', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController, createVectorCommands } = await import('@pixerate/editor/vector');
		const { CommandRegistry, createCommandToolProvider } = await import('@pixerate/editor/commands');
		const controller = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		controller.setViewport({ x: 10, y: 20, zoom: 2 });
		const commands = new CommandRegistry();
		commands.register(createVectorCommands(controller));
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands, { id: 'commands' }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const { target } = render(VectorCanvas, { controller, fitOnMount: false, playback });
		const surface = playback.surface('vector')!;
		expect(surface).toBeTruthy();
		// jsdom has no layout: report the canvas as visible.
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const result = await registry.callTool('commands__run_command', { id: 'vector.addShape', params: { kind: 'rect', x: 50, y: 40, width: 20, height: 10 } });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		const v = controller.getState().viewport;
		const cursor = target.querySelector('[data-vector-presence] [data-actor="agent"]') as HTMLElement;
		expect(cursor.style.transform).toBe(`translate(${70 * v.zoom + v.x}px, ${50 * v.zoom + v.y}px)`);
	});

	it('draws nothing and attaches nothing without a playback', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController } = await import('@pixerate/editor/vector');
		const { target } = render(VectorCanvas, { controller: new VectorEditorController(), fitOnMount: false });
		expect(target.querySelector('[data-vector-presence]')).toBeNull();
	});
});

describe('ImageEditor playback (Svelte)', () => {
	it('opens the panel a tool belongs to and plays on the image surface', async () => {
		HTMLCanvasElement.prototype.getContext = (() => null) as any;
		const { ImageEditor, createReactiveImageEditor } = await import('../src/image-editor');
		const { createImageEditorToolProvider } = await import('@pixerate/editor/image-editor');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		playback.install(registry);
		const fake = { width: 40, height: 30, naturalWidth: 40, naturalHeight: 30 } as unknown as HTMLImageElement;
		const editor = createReactiveImageEditor({ image: fake });
		registry.register(createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }));
		const { target, destroy } = render(ImageEditor, { editor, playback });
		const surface = playback.surface('image')!;
		expect(surface).toBeTruthy();
		(surface as { visible?: () => boolean }).visible = () => true;
		expect(target.querySelector('[data-control-id="contrast"]')).toBeNull();
		const steps = playback.record();
		const result = await registry.callTool('image__set_adjustments', { values: { contrast: 20 } });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
		expect(target.querySelector('[data-image-tab="adjust"]')!.getAttribute('aria-selected')).toBe('true');
		expect(target.querySelector('[data-control-id="contrast"]')).toBeTruthy();
		destroy();
		cleanups = [];
		target.remove();
		expect(playback.surface('image')).toBeUndefined();
	});
});

describe('SpreadsheetEditor playback (Svelte)', () => {
	it('clicks the cell a call names and types its value', async () => {
		const { SpreadsheetEditor, createReactiveSpreadsheet } = await import('../src/spreadsheet');
		const { createSpreadsheetToolProvider } = await import('@pixerate/editor/agent');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		playback.install(registry);
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			const { row, col } = this.dataset;
			if (this.tagName === 'TD' && row !== undefined && col !== undefined) return new DOMRect(Number(col) * 100, Number(row) * 20, 100, 20);
			return new DOMRect(0, 0, 800, 600);
		};
		try {
			const sheetState = createReactiveSpreadsheet();
			registry.register(createSpreadsheetToolProvider(sheetState.controller, { id: 'sheet', namespace: 'sheet' }));
			const { target } = render(SpreadsheetEditor, { sheetState, playback, virtualize: false });
			expect(playback.surface('spreadsheet')).toBeTruthy();
			const steps = playback.record();
			const result = await registry.callTool('sheet__set_cell', { cell: 'B2', value: 'Hi' });
			flushSync();
			expect(result.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
			expect((target.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 30px)');
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
		}
	});
});

describe('VideoTimeline playback (Svelte)', () => {
	it('drags a clip to its new start on the timeline', async () => {
		const { VideoTimeline } = await import('../src/video-editor');
		const { VideoEditorController, createVideoEditorToolProvider } = await import('@pixerate/editor/video-editor');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		playback.install(registry);
		const controller = new VideoEditorController();
		registry.register(createVideoEditorToolProvider(controller));
		await registry.callTool('video__add_video_asset', { kind: 'video', src: 'a.mp4', duration: 30000, width: 1920, height: 1080 });
		const added = await registry.callTool('video__add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a', duration: 6000 } });
		const clipId = (added.structuredContent as { clip: { id: string } }).clip.id;
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (this.dataset.trackLane !== undefined) return new DOMRect(150, 24, 1000, 44);
			if (this.dataset.clip !== undefined) return new DOMRect(150 + parseFloat(this.style.left || '0'), 28, parseFloat(this.style.width || '10'), 36);
			if (this.dataset.ruler !== undefined) return new DOMRect(150, 0, 1000, 24);
			return new DOMRect(0, 0, 1200, 300);
		};
		try {
			const { target } = render(VideoTimeline, { controller, playback, pxPerSecond: 100 });
			expect(playback.surface('video')).toBeTruthy();
			const steps = playback.record();
			const res = await registry.callTool('video__move_video_clip', { clip: clipId, start: 4000 });
			flushSync();
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'target', 'release', 'commit']);
			expect((target.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toMatch(/^translate\(550px, /);
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
		}
	});
});

describe('ParametersPanel and AnimationEditor playback (Svelte)', () => {
	const withRects = async (rects: (el: HTMLElement) => DOMRect | null, run: () => Promise<void>) => {
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			return rects(this) ?? new DOMRect(0, 0, 600, 400);
		};
		try {
			await run();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
		}
	};

	it('visits the control parameters.set changes', async () => {
		const { ParametersPanel } = await import('../src/parameters');
		const { ParametersController, createParameterCommands } = await import('@pixerate/editor/parameters');
		const { CommandRegistry, createCommandToolProvider } = await import('@pixerate/editor/commands');
		const params = new ParametersController({ schema: { fields: [{ id: 'speed', type: 'number', min: 0, max: 4, default: 1 }] } });
		const commands = new CommandRegistry();
		commands.register(createParameterCommands(params));
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands, { id: 'commands' }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		await withRects((el) => (el.dataset.parameterId === 'speed' ? new DOMRect(10, 40, 200, 30) : null), async () => {
			const { target } = render(ParametersPanel, { controller: params, playback });
			const steps = playback.record();
			const res = await registry.callTool('commands__run_command', { id: 'parameters.set', params: { values: { speed: 2 } } });
			flushSync();
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
			expect((target.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(110px, 55px)');
		});
	});

	it('clicks the shot an animation call works on', async () => {
		const { AnimationEditor } = await import('../src/animation-editor');
		const { AnimationEditorController, createAnimationEditorToolProvider, createMotionScene } = await import('@pixerate/editor/animation-editor');
		const controller = new AnimationEditorController({ scene: createMotionScene({ width: 320, height: 160, nodes: [] }, { name: 'task' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		await registry.callTool('animation__insert_shots', { shots: [{ id: 'intro', run: [] }] });
		await withRects((el) => (el.dataset.shot === 'intro' ? new DOMRect(300, 350, 80, 20) : null), async () => {
			const { target } = render(AnimationEditor, { controller, playback });
			const steps = playback.record();
			const res = await registry.callTool('animation__update_shot', { shot: 'intro', set: { label: 'Opening' } });
			flushSync();
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
			expect((target.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(340px, 360px)');
		});
	});
});

describe('ChartEditor playback (Svelte)', () => {
	it('plays inspector changes on the chart surface, sharing the director presence store', async () => {
		const { ChartEditor } = await import('../src/chart');
		const { ChartController, ChartDirector, ChartPresence, createChartToolProvider, layoutChart } = await import('@pixerate/editor/chart');
		const controller = new ChartController({ spec: { type: 'bar', categories: ['Q1'], series: [{ id: 'a', name: 'A', values: [1] }] } });
		const presence = new ChartPresence();
		const director = new ChartDirector(controller, presence, { scene: () => layoutChart(controller.getSpec(), { width: 400, height: 300 }), clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		registry.register(createChartToolProvider(controller, { id: 'chart', namespace: 'chart', director }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const { target } = render(ChartEditor, { controller, playback, canvasProps: { presence } });
		const surface = playback.surface('chart')!;
		expect(surface.presence).toBe(presence);
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const res = await registry.callTool('chart__update_chart', { title: 'Revenue' });
		flushSync();
		expect(res.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(controller.getSpec().title).toBe('Revenue');
		expect(target.querySelector('[data-chart-presence]')).toBeNull();
	});
});

describe('PaintEditor playback (Svelte)', () => {
	it('opens the panel a paint write belongs to, sharing the director presence store', async () => {
		HTMLCanvasElement.prototype.getContext = (() => null) as any;
		const { stubBrushThumbnails } = await import('./paint-thumbnails');
		const thumbs = stubBrushThumbnails();
		const { PaintEditor } = await import('../src/paint-editor');
		const { PaintEditorController, PaintDirector, PaintPresence, createPaintEditorToolProvider } = await import('@pixerate/editor/paint-editor');
		const controller = new PaintEditorController({ width: 64, height: 64 });
		const presence = new PaintPresence();
		const director = new PaintDirector(controller, presence, { clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		registry.register(createPaintEditorToolProvider(controller, { id: 'paint', namespace: 'paint', director }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		try {
			const { target } = render(PaintEditor, { controller, presence, playback });
			const surface = playback.surface('paint')!;
			expect(surface.presence).toBe(presence);
			(surface as { visible?: () => boolean }).visible = () => true;
			const steps = playback.record();
			const res = await registry.callTool('paint__add_layer', { name: 'Sky' });
			flushSync();
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'press', 'release', 'commit']);
			expect(target.querySelector('[data-paint-tab="layers"]')!.getAttribute('aria-selected')).toBe('true');
		} finally {
			thumbs.mockRestore();
		}
	});
});
