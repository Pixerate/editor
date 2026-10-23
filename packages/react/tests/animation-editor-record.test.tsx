// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ManualClock } from "@pixerate/editor/animation";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor } from "../src/animation-editor";

const SCENE: MotionScene = {
  version: 1,
  name: "demo",
  artwork: {
    width: 200,
    height: 100,
    nodes: [{ id: "box", type: "path", fill: "#ef4444", subpaths: [{ closed: true, anchors: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }] }] }],
  },
  shots: [{ id: "away", run: [{ type: "move", targets: ["box"], by: { x: 100, y: 0 }, duration: 400 }], hold: 0 }],
};

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const pointer = (el: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  el.dispatchEvent(event);
};
const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;

describe("AnimationRecordPanel and stage recording (React)", () => {
  it("records a drag on the stage as a new shot, one undo step", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => button("[data-record-start]").click());
    expect(controller.getState().recording).toMatchObject({ shot: "take", start: 400 });
    const stage = container.querySelector("[data-animation-stage]")!;
    expect(stage.hasAttribute("data-recording")).toBe(true);
    expect(container.textContent).toContain("● REC");
    const box = stage.querySelector('[id$="box"]')!;
    act(() => pointer(box, "pointerdown", 20, 20));
    expect(controller.getState().recording?.gesture).toEqual({ node: "box", mode: "move" });
    for (let i = 1; i <= 5; i++) {
      await act(() => clock.advance(40));
      act(() => pointer(stage, "pointermove", 20 + i * 4, 20));
    }
    act(() => pointer(stage, "pointerup", 40, 20));
    expect(controller.getState().recording?.gesture).toBeNull();
    act(() => button("[data-record-stop]").click());
    const take = controller.getScene().shots[1];
    expect(take).toMatchObject({ id: "take", label: "Recorded take" });
    expect(take.run).toEqual([{ type: "move", targets: ["box"], duration: 200, ease: "linear", to: { x: 150, y: 30 } }]);
    expect(controller.getState().undoLabel).toBe("Record take");
    expect(button("[data-record-start]")).toBeTruthy();
  });

  it("records the picked element's paint and scales with the Scale drag mode", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    act(() => root.render(<AnimationEditor controller={controller} />));
    const stage = container.querySelector("[data-animation-stage]")!;
    act(() => stage.querySelector('[id$="box"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => button("[data-record-start]").click());
    const fill = container.querySelector<HTMLInputElement>('[data-record-paint] input[type="color"]')!;
    expect(fill.value).toBe("#ef4444");
    await act(() => clock.advance(100));
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(fill, "#0ea5e9");
      fill.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => container.querySelectorAll<HTMLInputElement>('[name="animation-record-mode"]')[1].click());
    // Scale about the centre (130, 30), from 10 units right of it to 20. With no layout the stage
    // maps a client point to (x + 100, y + 50) in the artwork.
    const box = stage.querySelector('[id$="box"]')!;
    act(() => pointer(box, "pointerdown", 40, -20));
    expect(controller.getState().recording?.gesture?.mode).toBe("scale");
    await act(() => clock.advance(200));
    act(() => pointer(stage, "pointermove", 50, -20));
    act(() => pointer(stage, "pointerup", 50, -20));
    act(() => button("[data-record-stop]").click());
    const run = controller.getScene().shots[1].run;
    // Both start 100 ms in, when the fill was picked and the drag began.
    expect(run.map((c) => c.type).sort()).toEqual(["scale", "style"]);
    expect(run.find((c) => c.type === "style")).toMatchObject({ fill: "#0ea5e9", duration: 0 });
    expect(run.find((c) => c.type === "scale")).toMatchObject({ to: 2, duration: 200 });
    expect(run[0]).toMatchObject({ delay: 100 });
  });

  it("cancels without changing the scene and hides Record when read-only", () => {
    const controller = new AnimationEditorController({ scene: SCENE, clock: new ManualClock() });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => button("[data-record-start]").click());
    act(() => button("[data-record-cancel]").click());
    expect(controller.getState().recording).toBeNull();
    expect(controller.getScene().shots).toHaveLength(1);
    act(() => controller.setReadOnly(true));
    expect(container.querySelector("[data-record-start]")).toBeNull();
  });
});
