// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry, createAgentPlayback, createInstantPresenceClock, type AgentPlayback, type AgentToolProvider, type PlaybackRef, type PresenceStore } from '@pixerate/editor/tools';
import type { CanvasNode } from '@pixerate/editor/canvas';
import { useAgentToolProvider, useElementPlaybackSurface, usePlaybackSurface } from '../src';
import { useCanvasPlaybackSurface, type UseCanvasPlaybackSurfaceOptions } from '../src/canvas';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mount(ui: React.ReactElement) {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => root.render(ui));
	return { host, unmount: () => act(() => root.unmount()) };
}

const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

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

const hud = Object.assign(document.createElement('button'), { getBoundingClientRect: rect(110, 20, 20, 20) });

describe('useCanvasPlaybackSurface chrome', () => {
	function Board(props: { playback: AgentPlayback; registry: ToolRegistry; chrome: Partial<UseCanvasPlaybackSurfaceOptions>; onPresence: (p: PresenceStore) => void }) {
		const container = useRef<HTMLDivElement>(null);
		const nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: {}, width: 100, height: 40 }];
		props.onPresence(useCanvasPlaybackSurface(props.playback, 'canvas', { getNodes: () => nodes, viewport: { x: 50, y: 0, zoom: 2 }, container, visible: () => true, ...props.chrome }));
		useAgentToolProvider(props.registry, hudProvider('canvas'), { playback: props.playback });
		return <div ref={(el) => { (container as React.MutableRefObject<HTMLDivElement | null>).current = el; if (el) el.getBoundingClientRect = rect(10, 20, 400, 300); }} />;
	}

	it('locates chrome elements in flow coordinates and opens panels through open', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const opened: PlaybackRef[] = [];
		let presence!: PresenceStore;
		const { unmount } = mount(
			<Board playback={playback} registry={registry} onPresence={(p) => (presence = p)} chrome={{ locateElement: (ref) => (ref.kind === 'control' || ref.kind === 'panel' ? hud : null), open: (ref) => void opened.push(ref) }} />
		);
		expect(typeof playback.surface('canvas')!.open).toBe('function');
		// Nodes still come from the flow.
		expect(playback.surface('canvas')!.locate!({ kind: 'node', id: 'a' })).toEqual({ x: 0, y: 0, width: 100, height: 40 });
		// Client (110, 20, 20 × 20) → flow ((110 − 10 − 50) / 2, (20 − 20) / 2) at zoom 2.
		expect(playback.surface('canvas')!.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 25, y: 0, width: 10, height: 10 });
		const res = await act(() => registry.callTool('canvas__zoom_in', {}));
		expect(res.isError).toBeFalsy();
		expect(opened).toEqual([{ kind: 'panel', id: 'hud' }]);
		expect(presence.get('agent')).toMatchObject({ x: 30, y: 5 });
		unmount();
	});

	it('takes surface rects from locate before locateElement', () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const { unmount } = mount(
			<Board playback={playback} registry={new ToolRegistry()} onPresence={() => {}} chrome={{ locate: (ref) => (ref.id === 'zoom' ? { x: 1, y: 2, width: 3, height: 4 } : null), locateElement: () => hud }} />
		);
		const surface = playback.surface('canvas')!;
		expect(surface.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
		expect(surface.locate!({ kind: 'control', id: 'other' })).toEqual({ x: 25, y: 0, width: 10, height: 10 });
		expect(surface.open).toBeUndefined();
		unmount();
	});
});

describe('useElementPlaybackSurface chrome', () => {
	it('finds refs outside the element through locateElement and opens through open', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const opened: string[] = [];
		let presence!: PresenceStore;
		const Panel = () => {
			const el = useRef<HTMLDivElement>(null);
			presence = useElementPlaybackSurface(playback, 'panel', el, { locateElement: (ref) => (ref.kind === 'control' ? hud : null), open: (ref) => void opened.push(ref.id) });
			useAgentToolProvider(registry, hudProvider('panel'), { playback });
			return <div ref={(node) => { (el as React.MutableRefObject<HTMLDivElement | null>).current = node; if (node) node.getBoundingClientRect = rect(100, 10, 200, 100); }} />;
		};
		const { unmount } = mount(<Panel />);
		expect(playback.surface('panel')!.locate!({ kind: 'control', id: 'zoom' })).toEqual({ x: 10, y: 10, width: 20, height: 20 });
		await act(() => registry.callTool('panel__zoom_in', {}));
		expect(opened).toEqual(['hud']);
		expect(presence.get('agent')).toMatchObject({ x: 20, y: 20 });
		unmount();
	});
});

describe('usePlaybackSurface open', () => {
	it('defines open only when the options give one, so open steps are skipped', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const opened: string[] = [];
		const Surface = ({ withOpen }: { withOpen: boolean }) => {
			usePlaybackSurface(playback, 'board', { locate: () => ({ x: 0, y: 0, width: 10, height: 10 }), ...(withOpen ? { open: (ref: PlaybackRef) => void opened.push(ref.id) } : {}) });
			useAgentToolProvider(registry, hudProvider('board'), { playback });
			return null;
		};
		const a = mount(<Surface withOpen={false} />);
		expect(playback.surface('board')!.open).toBeUndefined();
		const steps = playback.record();
		await act(() => registry.callTool('board__zoom_in', {}));
		expect(steps.map((s) => s.step.type)).toContain('open');
		expect(opened).toEqual([]);
		a.unmount();
		const b = mount(<Surface withOpen />);
		expect(typeof playback.surface('board')!.open).toBe('function');
		await act(() => registry.callTool('board__zoom_in', {}));
		expect(opened).toEqual(['hud']);
		b.unmount();
	});
});
