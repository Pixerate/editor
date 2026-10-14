// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { HistoryManager } from "@pixerate/editor/history";
import {
  AnimationTimeline,
  ManualClock,
  useCanvasAnimation,
  withNodeAnimation,
  type CanvasAnimation,
  type CanvasNode,
} from "../src/canvas";

let container: HTMLDivElement;
let root: any;
const win = () => globalThis.window as any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const qa = <T extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll(sel)] as T[];

async function pointer(target: EventTarget, type: string, clientX: number, extra: Record<string, unknown> = {}) {
  await act(async () => {
    target.dispatchEvent(new (win().MouseEvent)(type, { bubbles: true, cancelable: true, clientX, ...extra }));
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new (win().Event)("change", { bubbles: true }));
  });
}

function card(): CanvasNode {
  return withNodeAnimation(
    { id: "card", position: { x: 0, y: 0 }, data: { label: "Card" }, selected: true, style: { opacity: 1 } },
    {
      tracks: {
        x: { keyframes: [{ time: 0, value: -100 }, { time: 500, value: 0 }] },
        opacity: { keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 1 }] },
      },
    },
  );
}

function Harness({ clock, history, onReady }: { clock: ManualClock; history: HistoryManager; onReady: (a: CanvasAnimation, nodes: CanvasNode[]) => void }) {
  const [nodes, setNodes] = useState<CanvasNode[]>(() => [card()]);
  const animation = useCanvasAnimation({ nodes, setNodes, clock, history });
  onReady(animation, nodes);
  return (
    <div>
      <div data-rendered-x={animation.displayNodes[0].position.x} data-rendered-opacity={animation.displayNodes[0].style.opacity} />
      <AnimationTimeline animation={animation} width={400} />
    </div>
  );
}

function setup() {
  const clock = new ManualClock();
  const history = new HistoryManager();
  const ref: { animation: CanvasAnimation | null; nodes: CanvasNode[] } = { animation: null, nodes: [] };
  const onReady = (a: CanvasAnimation, nodes: CanvasNode[]) => {
    ref.animation = a;
    ref.nodes = nodes;
  };
  return { clock, history, ref, element: <Harness clock={clock} history={history} onReady={onReady} /> };
}

describe("useCanvasAnimation + AnimationTimeline", () => {
  it("plays on the injected clock and renders the evaluated frame", async () => {
    const { clock, ref, element } = setup();
    await act(async () => root.render(element));
    expect(q("[data-rendered-x]").getAttribute("data-rendered-x")).toBe("-100");
    expect(qa("[data-track]").map((r) => r.getAttribute("data-track"))).toEqual(["card:x", "card:opacity"]);
    await click(q('[data-action="toggle-play"]'));
    expect(ref.animation!.playing).toBe(true);
    expect(q('[data-action="toggle-play"]').getAttribute("aria-label")).toBe("Pause");
    await act(async () => clock.advance(250));
    expect(q("[data-rendered-x]").getAttribute("data-rendered-x")).toBe("-50");
    expect(q("[data-rendered-opacity]").getAttribute("data-rendered-opacity")).toBe("0.25");
    expect(q("[data-time]").textContent).toContain("0.25s");
    await click(q('[data-action="toggle-play"]'));
    expect(ref.animation!.playing).toBe(false);
  });

  it("scrubs with the ruler and drags keyframes with snapping as one undo step", async () => {
    const { ref, history, element } = setup();
    await act(async () => root.render(element));
    const ruler = q("[data-timeline-ruler]");
    // 400px lane for 1000ms: 200px = 500ms.
    await pointer(ruler, "pointerdown", 200);
    expect(ref.animation!.state).toMatchObject({ time: 500, scrubbing: true });
    await pointer(window, "pointermove", 100);
    expect(ref.animation!.time).toBe(250);
    await pointer(window, "pointerup", 100);
    expect(ref.animation!.state.scrubbing).toBe(false);

    // Drag x's key at 500ms (x = 200px) by 97px ≈ 242.5ms: within 8px of opacity's key at 1000ms? No —
    // 500 + 242.5 = 742.5; the playhead (250) and 1000 are far, so it snaps to frames.
    const key = q('[data-track="card:x"] [data-keyframe="500"]');
    await pointer(key, "pointerdown", 200);
    expect(ref.animation!.selection).toEqual([{ nodeId: "card", property: "x", time: 500 }]);
    await pointer(window, "pointermove", 297);
    expect(ref.nodes[0].data.animation.tracks.x.keyframes[1].time).toBe(500); // preview only
    await pointer(window, "pointermove", 398);
    // 198px ≈ 495ms → 995ms is within 8px (20ms) of opacity's key at 1000ms.
    expect(ref.animation!.drag).toMatchObject({ target: 1000, delta: 500 });
    expect(q("[data-snap-target]")).not.toBeNull();
    await pointer(window, "pointerup", 398);
    expect(ref.nodes[0].data.animation.tracks.x.keyframes.map((k: any) => k.time)).toEqual([0, 1000]);
    expect(history.getState().undoCount).toBe(1);
    await act(async () => {
      history.undo();
    });
    expect(ref.nodes[0].data.animation.tracks.x.keyframes.map((k: any) => k.time)).toEqual([0, 500]);

    // Escape cancels a drag without editing.
    await pointer(q('[data-track="card:x"] [data-keyframe="500"]'), "pointerdown", 200);
    await pointer(window, "pointermove", 260);
    await act(async () => {
      window.dispatchEvent(new (win().KeyboardEvent)("keydown", { key: "Escape" }));
    });
    await pointer(window, "pointerup", 260);
    expect(ref.nodes[0].data.animation.tracks.x.keyframes.map((k: any) => k.time)).toEqual([0, 500]);
    expect(ref.animation!.drag).toBeNull();
  });

  it("sets easing, toggles record mode and tracks, adds and deletes keyframes", async () => {
    const { ref, element } = setup();
    await act(async () => root.render(element));
    const picker = q<HTMLSelectElement>("[data-easing-picker]");
    expect(picker.disabled).toBe(true);
    await pointer(q('[data-track="card:x"] [data-keyframe="0"]'), "pointerdown", 0);
    await pointer(window, "pointerup", 0);
    expect(q<HTMLSelectElement>("[data-easing-picker]").disabled).toBe(false);
    await choose(q<HTMLSelectElement>("[data-easing-picker]"), "ease-out");
    expect(ref.nodes[0].data.animation.tracks.x.keyframes[0].easing).toBe("ease-out");
    expect(q<HTMLSelectElement>("[data-easing-picker]").value).toBe("ease-out");
    // Shift-click adds to the selection.
    await pointer(q('[data-track="card:opacity"] [data-keyframe="1000"]'), "pointerdown", 400, { shiftKey: true });
    expect(ref.animation!.selection).toHaveLength(2);

    await click(q('[data-action="record"]'));
    expect(ref.animation!.recording).toBe(true);
    expect(q('[data-action="record"]').getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      q<HTMLInputElement>('[data-track="card:opacity"] input[type="checkbox"]').click();
    });
    expect(ref.nodes[0].data.animation.tracks.opacity.enabled).toBe(false);
    expect(q("[data-rendered-opacity]").getAttribute("data-rendered-opacity")).toBe("1");

    await act(async () => ref.animation!.seek(250));
    await click(q('[data-action="add-keyframe"]'));
    expect(ref.nodes[0].data.animation.tracks.x.keyframes.map((k: any) => k.time)).toEqual([0, 250, 500]);
    expect(qa('[data-track="card:x"] [data-keyframe]')).toHaveLength(3);
    await act(async () => {
      q("[data-animation-timeline]").dispatchEvent(new (win().KeyboardEvent)("keydown", { key: "Delete", bubbles: true }));
    });
    expect(ref.nodes[0].data.animation.tracks.x.keyframes.map((k: any) => k.time)).toEqual([0, 500]);

    await choose(q<HTMLSelectElement>("[data-loop-picker]"), "ping-pong");
    expect(ref.animation!.state.loop).toBe("ping-pong");
  });

  it("keys drags of animated nodes through applyDisplayChanges", async () => {
    const { ref, element } = setup();
    await act(async () => root.render(element));
    await act(async () => ref.animation!.seek(250));
    await act(async () => {
      const shown = ref.animation!.displayNodes;
      ref.animation!.applyDisplayChanges([{ ...shown[0], position: { x: 30, y: 0 } }]);
    });
    expect(ref.nodes[0].data.animation.tracks.x.keyframes).toEqual([
      { time: 0, value: -100 },
      { time: 250, value: 30 },
      { time: 500, value: 0 },
    ]);
    expect(q("[data-rendered-x]").getAttribute("data-rendered-x")).toBe("30");
  });
});
