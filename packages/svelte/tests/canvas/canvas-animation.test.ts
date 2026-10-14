import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { HistoryManager } from "@pixerate/editor/history";
import { AnimationTimeline, ManualClock, createCanvasAnimation, withNodeAnimation } from "../../src/canvas";
import type { CanvasNode } from "../../src/canvas/types";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function card(): CanvasNode {
  return withNodeAnimation(
    { id: "card", position: { x: 0, y: 0 }, data: { label: "Card" }, selected: true, style: { opacity: 1 } } as any,
    {
      tracks: {
        x: { keyframes: [{ time: 0, value: -100 }, { time: 500, value: 0 }] },
        opacity: { keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 1 }] },
      },
    },
  ) as any;
}

function setup() {
  let nodes: CanvasNode[] = [card()];
  const clock = new ManualClock();
  const history = new HistoryManager();
  const animation = createCanvasAnimation({ getNodes: () => nodes, setNodes: (n) => (nodes = n), clock, history });
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(AnimationTimeline, { target, props: { animation, width: 400 } });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
    animation.destroy();
  });
  return {
    clock,
    history,
    animation,
    target,
    get nodes() {
      return nodes;
    },
  };
}

const q = <T extends Element = HTMLElement>(root: Element, sel: string) => root.querySelector(sel) as T;
const qa = (root: Element, sel: string) => [...root.querySelectorAll(sel)];

function pointer(target: EventTarget, type: string, clientX: number, extra: Record<string, unknown> = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, ...extra }));
  flushSync();
}

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

const times = (n: CanvasNode, property: string) => (n.data as any).animation.tracks[property].keyframes.map((k: any) => k.time);

describe("createCanvasAnimation + AnimationTimeline", () => {
  it("plays on the injected clock and exposes the evaluated frame", async () => {
    const { clock, animation, target } = setup();
    expect(animation.displayNodes[0].position.x).toBe(-100);
    expect(qa(target, "[data-track]").map((r) => r.getAttribute("data-track"))).toEqual(["card:x", "card:opacity"]);
    q(target, '[data-action="toggle-play"]').click();
    flushSync();
    expect(animation.playing).toBe(true);
    expect(q(target, '[data-action="toggle-play"]').getAttribute("aria-label")).toBe("Pause");
    await clock.advance(250);
    flushSync();
    expect(animation.displayNodes[0].position.x).toBe(-50);
    expect((animation.displayNodes[0].style as any).opacity).toBe(0.25);
    expect(q(target, "[data-time]").textContent).toContain("0.25s");
    q(target, '[data-action="toggle-play"]').click();
    flushSync();
    expect(animation.playing).toBe(false);
  });

  it("scrubs with the ruler and drags keyframes with snapping as one undo step", () => {
    const ctx = setup();
    const { animation, target, history } = ctx;
    pointer(q(target, "[data-timeline-ruler]"), "pointerdown", 200);
    expect(animation.state).toMatchObject({ time: 500, scrubbing: true });
    pointer(window, "pointermove", 100);
    expect(animation.time).toBe(250);
    pointer(window, "pointerup", 100);
    expect(animation.state.scrubbing).toBe(false);

    pointer(q(target, '[data-track="card:x"] [data-keyframe="500"]'), "pointerdown", 200);
    expect(animation.selection).toEqual([{ nodeId: "card", property: "x", time: 500 }]);
    pointer(window, "pointermove", 398);
    expect(animation.drag).toMatchObject({ target: 1000, delta: 500 });
    expect(q(target, "[data-snap-target]")).not.toBeNull();
    expect(times(ctx.nodes[0], "x")).toEqual([0, 500]);
    pointer(window, "pointerup", 398);
    expect(times(ctx.nodes[0], "x")).toEqual([0, 1000]);
    expect(history.getState().undoCount).toBe(1);
    history.undo();
    flushSync();
    expect(times(ctx.nodes[0], "x")).toEqual([0, 500]);

    pointer(q(target, '[data-track="card:x"] [data-keyframe="500"]'), "pointerdown", 200);
    pointer(window, "pointermove", 260);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    pointer(window, "pointerup", 260);
    expect(times(ctx.nodes[0], "x")).toEqual([0, 500]);
    expect(animation.drag).toBeNull();
  });

  it("sets easing, toggles record mode and tracks, adds and deletes keyframes", () => {
    const ctx = setup();
    const { animation, target } = ctx;
    expect(q<HTMLSelectElement>(target, "[data-easing-picker]").disabled).toBe(true);
    pointer(q(target, '[data-track="card:x"] [data-keyframe="0"]'), "pointerdown", 0);
    pointer(window, "pointerup", 0);
    expect(q<HTMLSelectElement>(target, "[data-easing-picker]").disabled).toBe(false);
    choose(q<HTMLSelectElement>(target, "[data-easing-picker]"), "ease-out");
    expect((ctx.nodes[0].data as any).animation.tracks.x.keyframes[0].easing).toBe("ease-out");
    expect(q<HTMLSelectElement>(target, "[data-easing-picker]").value).toBe("ease-out");
    pointer(q(target, '[data-track="card:opacity"] [data-keyframe="1000"]'), "pointerdown", 400, { shiftKey: true });
    expect(animation.selection).toHaveLength(2);

    q(target, '[data-action="record"]').click();
    flushSync();
    expect(animation.recording).toBe(true);
    expect(q(target, '[data-action="record"]').getAttribute("aria-pressed")).toBe("true");

    q<HTMLInputElement>(target, '[data-track="card:opacity"] input[type="checkbox"]').click();
    flushSync();
    expect((ctx.nodes[0].data as any).animation.tracks.opacity.enabled).toBe(false);
    expect((animation.displayNodes[0].style as any).opacity).toBe(1);

    animation.seek(250);
    flushSync();
    q(target, '[data-action="add-keyframe"]').click();
    flushSync();
    expect(times(ctx.nodes[0], "x")).toEqual([0, 250, 500]);
    expect(qa(target, '[data-track="card:x"] [data-keyframe]')).toHaveLength(3);
    q(target, "[data-animation-timeline]").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    flushSync();
    expect(times(ctx.nodes[0], "x")).toEqual([0, 500]);

    choose(q<HTMLSelectElement>(target, "[data-loop-picker]"), "ping-pong");
    expect(animation.state.loop).toBe("ping-pong");
  });

  it("keys drags of animated nodes through applyDisplayChanges", () => {
    const ctx = setup();
    const { animation } = ctx;
    animation.seek(250);
    const shown = animation.displayNodes;
    animation.applyDisplayChanges([{ ...shown[0], position: { x: 30, y: 0 } }]);
    expect((ctx.nodes[0].data as any).animation.tracks.x.keyframes).toEqual([
      { time: 0, value: -100 },
      { time: 250, value: 30 },
      { time: 500, value: 0 },
    ]);
    expect(animation.displayNodes[0].position.x).toBe(30);
  });
});
