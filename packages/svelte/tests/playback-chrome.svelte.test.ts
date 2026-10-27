import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry, createAgentPlayback, createInstantPresenceClock, type AgentToolProvider, type PlaybackChromeOptions, type PlaybackRef, type PresenceStore } from '@pixerate/editor/tools';
import PlaybackChromeProbe from './fixtures/PlaybackChromeProbe.svelte';

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const hud = Object.assign(document.createElement('button'), { getBoundingClientRect: rect(110, 20, 20, 20) });

/** One write tool that opens the HUD panel and then visits a control on it. */
const hudProvider = (id: string): AgentToolProvider => ({
	id,
	tools: [
		{
			name: 'zoom_in',
			description: 'Zooms in.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			plan: () => [
				{ type: 'open', ref: { kind: 'panel', id: 'hud' } },
				{ type: 'target', ref: { kind: 'control', id: 'zoom' } }
			],
			handler: () => ({ zoomed: true })
		}
	]
});

function render(mode: 'canvas' | 'element' | 'plain', id: string, chrome: PlaybackChromeOptions = {}) {
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	const registry = new ToolRegistry();
	const target = document.createElement('div');
	document.body.appendChild(target);
	let presence!: PresenceStore;
	const instance = mount(PlaybackChromeProbe, { target, props: { playback, registry, provider: hudProvider(id), mode, chrome, onpresence: (p: PresenceStore) => (presence = p) } });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		target.remove();
	});
	return { playback, registry, presence: () => presence };
}

describe('createCanvasPlaybackSurface chrome', () => {
	it('locates chrome elements in flow coordinates and opens panels through open', async () => {
		const opened: PlaybackRef[] = [];
		const { playback, registry, presence } = render('canvas', 'canvas', { locateElement: (ref) => (ref.kind === 'control' || ref.kind === 'panel' ? hud : null), open: (ref) => void opened.push(ref) });
		const surface = playback.surface('canvas')!;
		expect(typeof surface.open).toBe('function');
		expect(surface.locate!({ kind: 'node', id: 'a' })).toEqual({ x: 0, y: 0, width: 100, height: 40 });
		// Client (110, 20, 20 × 20) → flow ((110 − 10 − 50) / 2, (20 − 20) / 2) at zoom 2.
		expect(surface.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 25, y: 0, width: 10, height: 10 });
		const res = await registry.callTool('canvas__zoom_in', {});
		expect(res.isError).toBeFalsy();
		expect(opened).toEqual([{ kind: 'panel', id: 'hud' }]);
		expect(presence().get('agent')).toMatchObject({ x: 30, y: 5 });
	});

	it('takes surface rects from locate before locateElement, and has no open without one', () => {
		const { playback } = render('canvas', 'canvas', { locate: (ref) => (ref.id === 'zoom' ? { x: 1, y: 2, width: 3, height: 4 } : null), locateElement: () => hud });
		const surface = playback.surface('canvas')!;
		expect(surface.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
		expect(surface.locate!({ kind: 'control', id: 'other' })).toEqual({ x: 25, y: 0, width: 10, height: 10 });
		expect(surface.open).toBeUndefined();
	});
});

describe('createElementPlaybackSurface chrome', () => {
	it('finds refs outside the element through locateElement and opens through open', async () => {
		const opened: string[] = [];
		const { playback, registry, presence } = render('element', 'panel', { locateElement: (ref) => (ref.kind === 'control' ? hud : null), open: (ref) => void opened.push(ref.id) });
		expect(playback.surface('panel')!.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 10, y: 10, width: 20, height: 20 });
		await registry.callTool('panel__zoom_in', {});
		expect(opened).toEqual(['hud']);
		expect(presence().get('agent')).toMatchObject({ x: 20, y: 20 });
	});
});

describe('createPlaybackSurface open', () => {
	it('defines open only when the options give one, so open steps are skipped', async () => {
		const a = render('plain', 'board');
		expect(a.playback.surface('board')!.open).toBeUndefined();
		const steps = a.playback.record();
		const res = await a.registry.callTool('board__zoom_in', {});
		expect(res.isError).toBeFalsy();
		expect(steps.map((s) => s.step.type)).toContain('open');

		const opened: string[] = [];
		const b = render('plain', 'board', { open: (ref) => void opened.push(ref.id) });
		expect(typeof b.playback.surface('board')!.open).toBe('function');
		await b.registry.callTool('board__zoom_in', {});
		expect(opened).toEqual(['hud']);
	});
});
