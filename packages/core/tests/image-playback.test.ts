import { describe, expect, it } from 'vitest';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '../src/tools';
import {
	ImageEditorController,
	createImageEditorToolProvider,
	createImagePlaybackLocator,
	imagePlaybackPanel,
	planImageToolPlayback
} from '../src/image-editor';

const W = 40;
const H = 30;

function setup() {
	const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
	const c = new ImageEditorController({ image: fake });
	c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
	const layer = c.addPixelLayer({ name: 'Paint', color: '#3366cc' });
	const registry = new ToolRegistry();
	registry.register(createImageEditorToolProvider(c, { id: 'image', namespace: 'image' }));
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	playback.install(registry);
	const opened: string[] = [];
	const locateLayer = createImagePlaybackLocator(c);
	const presence = new PresenceStore();
	playback.attach('image', {
		presence,
		defaultKind: 'layer',
		locate: (ref: PlaybackRef) => (ref.kind === 'panel' || ref.kind === 'control' ? { x: 0, y: -20, width: 10, height: 10 } : locateLayer(ref)),
		open: (ref) => void opened.push(ref.id),
		bounds: () => ({ x: 0, y: 0, width: W, height: H })
	});
	return { c, layer, registry, playback, opened, presence };
}

describe('planImageToolPlayback', () => {
	it('opens the panel a tool belongs to', () => {
		expect(imagePlaybackPanel('set_adjustments')).toBe('adjust');
		expect(imagePlaybackPanel('spot_heal')).toBe('paint');
		expect(imagePlaybackPanel('select_region')).toBe('select');
		expect(imagePlaybackPanel('add_text_layer')).toBe('annotate');
		expect(imagePlaybackPanel('set_crop')).toBe('crop');
		expect(imagePlaybackPanel('add_layer_effect')).toBe('layers');
		expect(imagePlaybackPanel('render_preview')).toBeNull();
	});

	it('traces strokes, drags boxes, clicks positions and visits sliders', () => {
		expect(planImageToolPlayback('clone_stamp', { points: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 9, y: 4 }] })!.map((s) => s.type)).toEqual(['open', 'move', 'press', 'drag', 'drag', 'release']);
		expect(planImageToolPlayback('select_region', { shape: 'rect', x: 2, y: 3, width: 10, height: 5 })!.slice(1)).toEqual([
			{ type: 'move', to: { x: 2, y: 3 } },
			{ type: 'press' },
			{ type: 'drag', to: { x: 12, y: 8 } },
			{ type: 'release' }
		]);
		expect(planImageToolPlayback('add_shape_layer', { shape: { kind: 'ellipse', x: 0, y: 0, width: 4, height: 4 } })![0]).toEqual({ type: 'open', ref: { kind: 'panel', id: 'annotate' } });
		expect(planImageToolPlayback('add_text_layer', { text: 'Hello\nthere', x: 3, y: 4 })!.map((s) => s.type)).toEqual(['open', 'move', 'press', 'release', 'type']);
		expect(planImageToolPlayback('set_adjustments', { values: { contrast: 20, 'layers.adj_1.vibrance': 10 } })!.slice(1)).toEqual([
			{ type: 'target', ref: { kind: 'control', id: 'contrast' } },
			{ type: 'target', ref: { kind: 'control', id: 'vibrance' } }
		]);
		expect(planImageToolPlayback('add_layer_effect', { layerId: 'L1', effect: 'drop-shadow' })).toEqual([
			{ type: 'open', ref: { kind: 'panel', id: 'layers' } },
			{ type: 'target', ref: { kind: 'layer', id: 'L1' } }
		]);
		expect(planImageToolPlayback('render_preview', {})).toBeNull();
	});
});

describe('image tools through playback', () => {
	it('every write tool of the provider has a plan and plays on the image surface', () => {
		const c = new ImageEditorController();
		const provider = createImageEditorToolProvider(c);
		expect(provider.playbackSurface).toBe('image');
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		expect(tools.filter((t) => !t.annotations?.readOnlyHint && typeof t.plan !== 'function').map((t) => t.name)).toEqual([]);
	});

	it('opens the paint panel and traces a stroke, with the same result as without playback', async () => {
		const a = setup();
		const steps = a.playback.record();
		const args = { points: [{ x: 5, y: 5 }, { x: 20, y: 10 }, { x: 30, y: 20 }], tool: 'brush' };
		const res = await a.registry.callTool('image__paint_stroke', args);
		expect(res.isError).toBeFalsy();
		expect(a.opened).toEqual(['paint']);
		expect(steps.map((r) => r.step.type).slice(0, 7)).toEqual(['open', 'move', 'press', 'drag', 'drag', 'release', 'commit']);
		expect(a.presence.get('agent')).toMatchObject({ x: 30, y: 20 });

		const b = setup();
		b.playback.speed = Infinity;
		const plain = await b.registry.callTool('image__paint_stroke', args);
		const norm = (r: unknown) => JSON.stringify(r).replace(/layer_[a-z0-9_]+/gi, 'id');
		expect(norm(plain)).toEqual(norm(res));
	});

	it('visits the layer a call names and rings a new layer from the result', async () => {
		const { registry, playback, layer, c } = setup();
		const steps = playback.record();
		await registry.callTool('image__set_layer_properties', { layerId: layer, opacity: 0.5 });
		expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
		expect((steps[1]!.step as { ref: PlaybackRef }).ref).toEqual({ kind: 'layer', id: layer });
		expect(c.getLayer(layer)).toBeTruthy();
	});

	it('returns the same error unchanged', async () => {
		const { registry } = setup();
		const res = await registry.callTool('image__set_layer_properties', { layerId: 'ghost', opacity: 0.5 });
		expect(res.isError).toBe(true);
		expect((res.content[0] as { text: string }).text).toMatch(/ghost/);
	});

	it('skips open steps on a surface without open', async () => {
		const { registry, playback, c } = setup();
		const surface = playback.surface('image')!;
		delete (surface as { open?: unknown }).open;
		const steps = playback.record();
		await registry.callTool('image__select_region', { shape: 'rect', x: 1, y: 1, width: 5, height: 5 });
		expect(steps[0]!.step.type).toBe('open');
		expect(c.getState().selection).toBeTruthy();
	});
});
