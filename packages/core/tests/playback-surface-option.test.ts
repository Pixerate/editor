import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, type AgentToolProvider, type PlaybackRef } from '../src/tools';
import {
	ImageEditorController,
	createImageEditorToolProvider,
	createImageEffectsToolProvider,
	createImagePlaybackLocator,
	withImagePlayback
} from '../src/image-editor';
import { VideoEditorController, createVideoEditorToolProvider, createVideoEffectsToolProvider, withVideoPlayback } from '../src/video-editor';
import { AnimationEditorController, createAnimationEditorToolProvider, createAnimationEffectsToolProvider, withAnimationPlayback } from '../src/animation-editor';
import { ChartController, createChartToolProvider, withChartPlayback } from '../src/chart';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectsToolProvider, withPaintPlayback } from '../src/paint-editor';

const W = 40;
const H = 30;

function imageController() {
	const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
	const c = new ImageEditorController({ image: fake });
	c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
	return c;
}

const bare = (id: string, playbackSurface?: string): AgentToolProvider => ({ id, tools: [], ...(playbackSurface ? { playbackSurface } : {}) });

describe('playbackSurface option on the tool-provider factories', () => {
	const factories: Array<[string, (surface?: string) => AgentToolProvider, string]> = [
		['createImageEditorToolProvider', (s) => createImageEditorToolProvider(new ImageEditorController(), { playbackSurface: s }), 'image'],
		['createImageEffectsToolProvider', (s) => createImageEffectsToolProvider(new ImageEditorController(), { playbackSurface: s }), 'image'],
		['createVideoEditorToolProvider', (s) => createVideoEditorToolProvider(new VideoEditorController({ clock: new ManualClock() }), { playbackSurface: s }), 'video'],
		['createVideoEffectsToolProvider', (s) => createVideoEffectsToolProvider(new VideoEditorController({ clock: new ManualClock() }), { playbackSurface: s }), 'video'],
		['createAnimationEditorToolProvider', (s) => createAnimationEditorToolProvider(new AnimationEditorController(), { playbackSurface: s }), 'animation'],
		['createAnimationEffectsToolProvider', (s) => createAnimationEffectsToolProvider(new AnimationEditorController(), { playbackSurface: s }), 'animation'],
		['createChartToolProvider', (s) => createChartToolProvider(new ChartController(), { playbackSurface: s }), 'chart'],
		['createPaintEditorToolProvider', (s) => createPaintEditorToolProvider(new PaintEditorController({ width: 64, height: 64 }), { playbackSurface: s }), 'paint'],
		['createPaintEffectsToolProvider', (s) => createPaintEffectsToolProvider(new PaintEditorController({ width: 64, height: 64 }), { playbackSurface: s }), 'paint']
	];

	it.each(factories)('%s keeps its default surface and takes an explicit one', (_name, make, fallback) => {
		expect(make().playbackSurface).toBe(fallback);
		expect(make('node-7:surface').playbackSurface).toBe('node-7:surface');
	});
});

describe('with*Playback surface precedence', () => {
	const wrappers: Array<[string, (p: AgentToolProvider, surface?: string) => AgentToolProvider, string]> = [
		['withImagePlayback', (p, s) => withImagePlayback(p, s), 'image'],
		['withVideoPlayback', (p, s) => withVideoPlayback(p, s), 'video'],
		['withAnimationPlayback', (p, s) => withAnimationPlayback(p, s), 'animation'],
		['withChartPlayback', (p, s) => withChartPlayback(p, { director: false, surface: s }), 'chart'],
		['withPaintPlayback', (p, s) => withPaintPlayback(p, { director: false, surface: s }), 'paint']
	];

	it.each(wrappers)('%s: explicit surface, then the provider\'s, then the default', (_name, wrap, fallback) => {
		expect(wrap(bare('p')).playbackSurface).toBe(fallback);
		expect(wrap(bare('p', 'own')).playbackSurface).toBe('own');
		expect(wrap(bare('p', 'own'), 'explicit').playbackSurface).toBe('explicit');
		expect(wrap(bare('p'), 'explicit').playbackSurface).toBe('explicit');
	});

	it('a provider wrapped twice keeps the explicit surface of the outer call', () => {
		const inner = createImageEditorToolProvider(new ImageEditorController());
		expect(inner.playbackSurface).toBe('image');
		expect(withImagePlayback(inner, 'image4:surface').playbackSurface).toBe('image4:surface');
	});
});

describe('two image editors on one registry', () => {
	function setup() {
		const registry = new ToolRegistry();
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const editors = ['image1', 'image2'].map((id) => {
			const c = imageController();
			const layer = c.addPixelLayer({ name: 'Paint', color: '#3366cc' });
			const surfaceId = `${id}:surface`;
			const providers = [
				createImageEditorToolProvider(c, { id, namespace: id, playbackSurface: surfaceId }),
				createImageEffectsToolProvider(c, { id: `${id}-effects`, namespace: `${id}-effects`, playbackSurface: surfaceId })
			];
			for (const p of providers) registry.register(p);
			const opened: string[] = [];
			const presence = new PresenceStore();
			const locateLayer = createImagePlaybackLocator(c);
			playback.attach(surfaceId, {
				presence,
				defaultKind: 'layer',
				locate: (ref: PlaybackRef) => (ref.kind === 'panel' || ref.kind === 'control' ? { x: 0, y: -20, width: 10, height: 10 } : locateLayer(ref)),
				open: (ref) => void opened.push(ref.id),
				bounds: () => ({ x: 0, y: 0, width: W, height: H })
			});
			return { id, c, layer, surfaceId, opened, presence, providers };
		});
		return { registry, playback, editors };
	}

	it('plays each editor\'s calls on its own surface', async () => {
		const { registry, playback, editors } = setup();
		const [a, b] = editors as [(typeof editors)[0], (typeof editors)[0]];
		const steps = playback.record();

		const r1 = await registry.callTool('image1__set_layer_properties', { layerId: a.layer, opacity: 0.5 });
		expect(r1.isError).toBeFalsy();
		const r2 = await registry.callTool('image2__paint_stroke', { points: [{ x: 5, y: 5 }, { x: 20, y: 10 }], tool: 'brush' });
		expect(r2.isError).toBeFalsy();

		const surfacesOf = (tool: string) => [...new Set(steps.filter((s) => s.tool === tool).map((s) => s.surface))];
		expect(surfacesOf('image1__set_layer_properties')).toEqual(['image1:surface']);
		expect(surfacesOf('image2__paint_stroke')).toEqual(['image2:surface']);
		expect(a.opened).toEqual(['layers']);
		expect(b.opened).toEqual(['paint']);
		expect(b.presence.get('agent')).toMatchObject({ x: 20, y: 10 });
		expect(a.c.getLayer(a.layer)?.opacity).toBe(0.5);
		expect(b.c.getLayer(b.layer)?.opacity).not.toBe(0.5);
	});

	it('the effect providers play on the same per-editor surface', () => {
		const { editors } = setup();
		for (const e of editors) expect(e.providers.map((p) => p.playbackSurface)).toEqual([e.surfaceId, e.surfaceId]);
	});
});
