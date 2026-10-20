import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { CanvasScenesStore, createCanvasEffectsController, type CanvasNode, type ShapeDescription } from "@pixerate/editor/canvas";
import { CanvasEffectsPanel } from "../src/canvas";
import CanvasEffectsProbe from "./fixtures/CanvasEffectsProbe.svelte";

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});
beforeAll(() => {
	window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
let target: HTMLElement;
function render(component: any, props: Record<string, any>) {
	target = document.createElement("div");
	document.body.appendChild(target);
	const instance = mount(component, { target, props });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		target.remove();
	});
}
const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
};
const click = async (el: Element) => {
	(el as HTMLElement).click();
	flushSync();
	await settle();
};
const button = (text: string) => [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

describe("canvas effects (Svelte)", () => {
	it("ShapeNode draws its effect only with a provider", async () => {
		const shape: ShapeDescription = { kind: "rect", fill: "#f00", effect: { effect: "fake.gradient", mode: "fill", values: {} } };
		render(CanvasEffectsProbe, { provider: null, shape });
		expect(target.querySelector("[data-canvas-effect]")).toBeNull();
		render(CanvasEffectsProbe, { provider: createFakeEffectProvider(), shape });
		await settle();
		const canvas = target.querySelector('[data-canvas-effect="fake.gradient"]')!;
		expect(canvas).not.toBeNull();
		expect(canvas.closest("foreignObject")).not.toBeNull();
	});

	it("CanvasEffectsPanel fills a node, sets a scene transition and removes both", async () => {
		let nodes: CanvasNode[] = [{ id: "a", position: { x: 0, y: 0 }, data: { shape: { kind: "rect", fill: "#f00" } } }];
		const scenes = new CanvasScenesStore({ initialScenes: [{ id: "s1", name: "One", viewport: { x: 0, y: 0, zoom: 1 } }] });
		const c = createCanvasEffectsController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), scenes, effects: createFakeEffectProvider() });
		render(CanvasEffectsPanel, { controller: c, nodeId: "a", shape: (nodes[0].data as { shape: ShapeDescription }).shape, sceneId: "s1" });
		await click(button("Fill…"));
		await click(target.querySelector('[data-effect-id="fake.gradient"]')!);
		expect((nodes[0].data as { shape: ShapeDescription }).shape.effect).toMatchObject({ effect: "fake.gradient", mode: "fill" });
		await click(button("Scene transition…"));
		await click(target.querySelector('[data-effect-id="fake.crossfade"]')!);
		expect(scenes.getScene("s1")?.transition?.effect).toBe("fake.crossfade");
		await click(target.querySelector('[aria-label="Remove transition"]')!);
		expect(scenes.getScene("s1")?.transition).toBeUndefined();
	});
});
