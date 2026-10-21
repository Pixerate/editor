// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry, PresenceStore, createAgentPlayback, createInstantPresenceClock, type AgentPlayback, type AgentToolProvider } from '@pixerate/editor/tools';
import { createEditorMcpToolProvider, type AgentStep } from '@pixerate/editor/agent';
import type { CanvasNode } from '@pixerate/editor/canvas';
import { AgentPlaybackProvider, PresenceLayer, useAgentToolProvider, usePlaybackSurface } from '../src';
import { useCanvasPlaybackSurface } from '../src/canvas';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mount(ui: React.ReactElement) {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => root.render(ui));
	return { host, root, unmount: () => act(() => root.unmount()) };
}

describe('PresenceLayer', () => {
	it('draws each actor at its viewport position with its note and focus ring', () => {
		const presence = new PresenceStore();
		const { host, unmount } = mount(<PresenceLayer presence={presence} viewport={{ x: 10, y: 20, zoom: 2 }} />);
		expect(host.querySelector('[data-testid="presence-layer"]')).toBeNull();
		act(() => presence.set({ id: 'a', name: 'Agent', color: '#7c3aed', x: 5, y: 5, message: 'Aligning', focus: { x: 0, y: 0, width: 10, height: 10 } }));
		const layer = host.querySelector('.pixerate-presence')!;
		expect(layer).toBeTruthy();
		expect((layer.querySelector('[data-actor="a"]') as HTMLElement).style.transform).toBe('translate(20px, 30px)');
		expect(layer.querySelector('[data-actor-message="a"]')!.textContent).toBe('Aligning');
		const ring = layer.querySelector('[data-actor-focus="a"]') as HTMLElement;
		expect([ring.style.left, ring.style.width]).toEqual(['6px', '28px']);
		unmount();
	});
});

describe('usePlaybackSurface', () => {
	it('attaches from context while mounted and detaches on unmount', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const provider: AgentToolProvider = {
			id: 'board',
			tools: [{ name: 'poke', description: 'poke', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, handler: ({ id }) => ({ poked: id }) }]
		};
		let presence!: PresenceStore;
		const Surface = () => {
			presence = usePlaybackSurface(undefined, 'board', { locate: (ref) => (ref.id === 'x' ? { x: 0, y: 0, width: 10, height: 10 } : null) });
			useAgentToolProvider(registry, provider, { playback });
			return null;
		};
		const { unmount } = mount(
			<AgentPlaybackProvider playback={playback}>
				<Surface />
			</AgentPlaybackProvider>
		);
		expect(playback.surface('board')).toBeTruthy();
		const steps = playback.record();
		await act(() => registry.callTool('board__poke', { id: 'x' }));
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(presence.get('agent')).toMatchObject({ x: 5, y: 5 });
		unmount();
		expect(playback.surface('board')).toBeUndefined();
	});
});

describe('useCanvasPlaybackSurface', () => {
	it('plays canvas tool calls on the flow and maps the cursor through the viewport', async () => {
		const playback: AgentPlayback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' }, width: 100, height: 40 }];
		const Board = () => {
			const container = useRef<HTMLDivElement>(null);
			const viewport = { x: 50, y: 0, zoom: 2 };
			const presence = useCanvasPlaybackSurface(playback, 'canvas', { getNodes: () => nodes, viewport, container, visible: () => true });
			const provider = useMemo(
				() =>
					createEditorMcpToolProvider({
						id: 'canvas',
						surfaces: { canvas: true, prompt: false },
						getSnapshot: () => ({ canvas: { nodes, edges: [] } }),
						applySteps: (steps: AgentStep[]) => {
							for (const s of steps) if (s.type === 'step:canvas_select') nodes = nodes.map((n) => ({ ...n, selected: s.nodeIds.includes(n.id) }));
						}
					}),
				[]
			);
			useAgentToolProvider(registry, provider, { playback });
			return (
				<div ref={container} style={{ position: 'relative' }}>
					<PresenceLayer presence={presence} viewport={viewport} />
				</div>
			);
		};
		const { host, unmount } = mount(<Board />);
		const steps = playback.record();
		const result = await act(() => registry.callTool('canvas__canvas_select', { nodeIds: ['a'] }));
		expect(result.isError).toBeFalsy();
		expect(nodes[0]!.selected).toBe(true);
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'commit']);
		expect((host.querySelector('[data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 40px)');
		unmount();
	});
});

describe('VectorCanvas playback', () => {
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
		const { host, unmount } = mount(
			<AgentPlaybackProvider playback={playback}>
				<VectorCanvas controller={controller} fitOnMount={false} />
			</AgentPlaybackProvider>
		);
		expect(playback.surface('vector')).toBeTruthy();
		// jsdom has no layout: report the canvas as visible.
		const surface = playback.surface('vector')!;
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const result = await act(() => registry.callTool('commands__run_command', { id: 'vector.addShape', params: { kind: 'rect', x: 50, y: 40, width: 20, height: 10 } }));
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		const v = controller.getState().viewport;
		const cursor = host.querySelector('[data-vector-presence] [data-actor="agent"]') as HTMLElement;
		expect(cursor.style.transform).toBe(`translate(${70 * v.zoom + v.x}px, ${50 * v.zoom + v.y}px)`);
		unmount();
		expect(playback.surface('vector')).toBeUndefined();
	});

	it('draws nothing and attaches nothing without a playback', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController } = await import('@pixerate/editor/vector');
		const { host, unmount } = mount(<VectorCanvas controller={new VectorEditorController()} fitOnMount={false} />);
		expect(host.querySelector('[data-vector-presence]')).toBeNull();
		unmount();
	});
});

describe('ImageEditor playback', () => {
	it('opens the panel a tool belongs to and plays on the image surface', async () => {
		window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
		const { ImageEditor, useImageEditor } = await import('../src/image-editor');
		const { createImageEditorToolProvider } = await import('@pixerate/editor/image-editor');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const fake = { width: 40, height: 30, naturalWidth: 40, naturalHeight: 30 } as unknown as HTMLImageElement;
		const Host = () => {
			const editor = useImageEditor({ image: fake });
			const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }), [editor.controller]);
			useAgentToolProvider(registry, provider, { playback });
			return <ImageEditor editor={editor} playback={playback} />;
		};
		const { host, unmount } = mount(<Host />);
		const surface = playback.surface('image')!;
		expect(surface).toBeTruthy();
		(surface as { visible?: () => boolean }).visible = () => true;
		expect(host.querySelector('[data-control-id="contrast"]')).toBeNull();
		const steps = playback.record();
		const result = await act(() => registry.callTool('image__set_adjustments', { values: { contrast: 20 } }));
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
		// The cursor clicked the Adjustments tab, so its sliders are on screen.
		expect(host.querySelector('[data-image-tab="adjust"]')!.className).toContain('bg-indigo-600');
		expect(host.querySelector('[data-control-id="contrast"]')).toBeTruthy();
		expect(host.querySelector('.pixerate-presence')).toBeTruthy();
		unmount();
		expect(playback.surface('image')).toBeUndefined();
	});
});

describe('SpreadsheetEditor playback', () => {
	it('clicks the cell a call names and types its value', async () => {
		const { SpreadsheetEditor, useSpreadsheetEditor } = await import('../src/spreadsheet');
		const { createSpreadsheetToolProvider } = await import('@pixerate/editor/agent');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		// jsdom has no layout: give cells a 100 × 20 grid.
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			const { row, col } = this.dataset;
			if (this.tagName === 'TD' && row !== undefined && col !== undefined) return new DOMRect(Number(col) * 100, Number(row) * 20, 100, 20);
			return new DOMRect(0, 0, 800, 600);
		};
		try {
			const Host = () => {
				const state = useSpreadsheetEditor();
				const provider = useMemo(() => createSpreadsheetToolProvider(state.controller, { id: 'sheet', namespace: 'sheet' }), [state.controller]);
				useAgentToolProvider(registry, provider, { playback });
				return <SpreadsheetEditor state={state} playback={playback} virtualize={false} />;
			};
			const { host, unmount } = mount(<Host />);
			expect(playback.surface('spreadsheet')).toBeTruthy();
			const steps = playback.record();
			const result = await act(() => registry.callTool('sheet__set_cell', { cell: 'B2', value: 'Hi' }));
			expect(result.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
			expect((host.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 30px)');
			unmount();
			expect(playback.surface('spreadsheet')).toBeUndefined();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
		}
	});
});

describe('VideoTimeline playback', () => {
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
		// jsdom has no layout: lanes are rows under a 24 px ruler, 150 px in; clips sit at their style.left.
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (this.dataset.trackLane !== undefined) return new DOMRect(150, 24 + 44 * [...this.parentElement!.parentElement!.children].indexOf(this.parentElement!) - 44, 1000, 44);
			if (this.dataset.clip !== undefined) {
				const lane = (this.closest('[data-track-lane]') as HTMLElement).getBoundingClientRect();
				return new DOMRect(lane.left + parseFloat(this.style.left), lane.top + 4, parseFloat(this.style.width), 36);
			}
			if (this.dataset.ruler !== undefined) return new DOMRect(150, 0, 1000, 24);
			return new DOMRect(0, 0, 1200, 300);
		};
		try {
			const { host, unmount } = mount(<VideoTimeline controller={controller} playback={playback} pxPerSecond={100} onPxPerSecondChange={() => {}} />);
			expect(playback.surface('video')).toBeTruthy();
			const steps = playback.record();
			const res = await act(() => registry.callTool('video__move_video_clip', { clip: clipId, start: 4000 }));
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'target', 'release', 'commit']);
			const cursor = host.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement;
			// 4000 ms at 100 px/s from the lane's left (150 px).
			expect(cursor.style.transform).toMatch(/^translate\(550px, /);
			unmount();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
		}
	});
});

describe('ParametersPanel and AnimationEditor playback', () => {
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
			const { host, unmount } = mount(<ParametersPanel controller={params} playback={playback} />);
			const steps = playback.record();
			const res = await act(() => registry.callTool('commands__run_command', { id: 'parameters.set', params: { values: { speed: 2 } } }));
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
			expect((host.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(110px, 55px)');
			unmount();
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
			const { host, unmount } = mount(<AnimationEditor controller={controller} playback={playback} />);
			const steps = playback.record();
			const res = await act(() => registry.callTool('animation__update_shot', { shot: 'intro', set: { label: 'Opening' } }));
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
			expect((host.querySelector('.pixerate-presence [data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(340px, 360px)');
			unmount();
		});
	});
});

describe('ChartEditor playback', () => {
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
		const { host, unmount } = mount(<ChartEditor controller={controller} playback={playback} canvasProps={{ presence }} />);
		const surface = playback.surface('chart')!;
		expect(surface.presence).toBe(presence);
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const res = await act(() => registry.callTool('chart__update_chart', { title: 'Revenue' }));
		expect(res.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(controller.getSpec().title).toBe('Revenue');
		// The editor draws the cursor layer; the canvas's own SVG layer is off.
		expect(host.querySelector('[data-chart-presence]')).toBeNull();
		unmount();
	});
});

describe('PaintEditor playback', () => {
	it('opens the panel a paint write belongs to, sharing the director presence store', async () => {
		window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
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
			const { host, unmount } = mount(<PaintEditor controller={controller} presence={presence} playback={playback} />);
			const surface = playback.surface('paint')!;
			expect(surface.presence).toBe(presence);
			(surface as { visible?: () => boolean }).visible = () => true;
			expect(host.querySelector('[data-paint-tab="layers"]')!.getAttribute('aria-selected')).toBe('false');
			const steps = playback.record();
			const res = await act(() => registry.callTool('paint__add_layer', { name: 'Sky' }));
			expect(res.isError).toBeFalsy();
			expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'press', 'release', 'commit']);
			expect(host.querySelector('[data-paint-tab="layers"]')!.getAttribute('aria-selected')).toBe('true');
			expect(host.querySelector('[data-paint-presence]')).toBeNull();
			unmount();
		} finally {
			thumbs.mockRestore();
		}
	});
});
