// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { CanvasScenesStore, createCanvasEffectsController, type CanvasNode, type ShapeDescription } from '@pixerate/editor/canvas';
import { CanvasEffectsPanel, CanvasEffectsProvider, ShapeNode } from '../src/canvas';

let container: HTMLDivElement;
let root: any;
beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element) => {
	await act(async () => (el as HTMLElement).click());
	await settle();
	await settle();
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

describe('canvas effects (React)', () => {
	it('ShapeNode draws its effect only inside a provider', () => {
		const shape: ShapeDescription = { kind: 'rect', fill: '#f00', effect: { effect: 'fake.gradient', mode: 'fill', values: {} } };
		act(() => root.render(<ShapeNode data={{ shape }} width={40} height={20} />));
		expect(container.querySelector('[data-canvas-effect]')).toBeNull();
		act(() => root.render(<CanvasEffectsProvider provider={createFakeEffectProvider()}><ShapeNode data={{ shape }} width={40} height={20} /></CanvasEffectsProvider>));
		const canvas = container.querySelector('[data-canvas-effect="fake.gradient"]')!;
		expect(canvas).not.toBeNull();
		expect(canvas.closest('foreignObject')).not.toBeNull();
		act(() => root.render(<CanvasEffectsProvider provider={createFakeEffectProvider()}><ShapeNode data={{ shape: { ...shape, effect: { ...shape.effect!, mode: 'overlay' } } }} width={40} height={20} /></CanvasEffectsProvider>));
		expect(container.querySelector('[data-canvas-effect]')!.closest('foreignObject')).toBeNull();
	});

	it('CanvasEffectsPanel fills a node, sets a scene transition and removes both', async () => {
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { shape: { kind: 'rect', fill: '#f00' } } }];
		const scenes = new CanvasScenesStore({ initialScenes: [{ id: 's1', name: 'One', viewport: { x: 0, y: 0, zoom: 1 } }] });
		const c = createCanvasEffectsController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), scenes, effects: createFakeEffectProvider() });
		const view = () => <CanvasEffectsPanel controller={c} nodeId="a" shape={(nodes[0].data as { shape: ShapeDescription }).shape} sceneId="s1" />;
		act(() => root.render(view()));
		await click(button('Fill…'));
		await click(container.querySelector('[data-effect-id="fake.gradient"]')!);
		expect((nodes[0].data as { shape: ShapeDescription }).shape.effect).toMatchObject({ effect: 'fake.gradient', mode: 'fill' });
		act(() => root.render(view()));
		expect(container.querySelector('[data-canvas-node-effect="a"]')).not.toBeNull();
		await click(button('Scene transition…'));
		await click(container.querySelector('[data-effect-id="fake.crossfade"]')!);
		expect(scenes.getScene('s1')?.transition?.effect).toBe('fake.crossfade');
		await click(container.querySelector('[aria-label="Remove effect"]')!);
		expect((nodes[0].data as { shape: ShapeDescription }).shape.effect).toBeUndefined();
		await click(container.querySelector('[aria-label="Remove transition"]')!);
		expect(scenes.getScene('s1')?.transition).toBeUndefined();
	});
});
