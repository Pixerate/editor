import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ManualClock } from "@pixerate/editor/animation";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor } from "../src/animation-editor";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return { target, instance };
}

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

const pointer = (el: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  el.dispatchEvent(event);
  flushSync();
};

describe("AnimationRecordPanel and stage recording (Svelte)", () => {
  it("records a drag on the stage as a new shot, one undo step", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    const { target } = render(AnimationEditor, { controller });
    target.querySelector<HTMLButtonElement>("[data-record-start]")!.click();
    flushSync();
    expect(controller.getState().recording).toMatchObject({ shot: "take", start: 400 });
    const stage = target.querySelector("[data-animation-stage]")!;
    expect(stage.hasAttribute("data-recording")).toBe(true);
    expect(target.textContent).toContain("● REC");
    pointer(stage.querySelector('[id$="box"]')!, "pointerdown", 20, 20);
    expect(controller.getState().recording?.gesture).toEqual({ node: "box", mode: "move" });
    for (let i = 1; i <= 5; i++) {
      await clock.advance(40);
      pointer(stage, "pointermove", 20 + i * 4, 20);
    }
    pointer(stage, "pointerup", 40, 20);
    target.querySelector<HTMLButtonElement>("[data-record-stop]")!.click();
    flushSync();
    expect(controller.getScene().shots[1].run).toEqual([{ type: "move", targets: ["box"], duration: 200, ease: "linear", to: { x: 150, y: 30 } }]);
    expect(controller.getState().undoLabel).toBe("Record take");
    expect(target.querySelector("[data-record-start]")).toBeTruthy();
  });

  it("records the picked element's paint and scales with the Scale drag mode", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    const { target } = render(AnimationEditor, { controller });
    const stage = target.querySelector("[data-animation-stage]")!;
    stage.querySelector('[id$="box"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.querySelector<HTMLButtonElement>("[data-record-start]")!.click();
    flushSync();
    const fill = target.querySelector<HTMLInputElement>('[data-record-paint] input[type="color"]')!;
    expect(fill.value).toBe("#ef4444");
    await clock.advance(100);
    fill.value = "#0ea5e9";
    fill.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelectorAll<HTMLInputElement>('[name="animation-record-mode"]')[1].click();
    flushSync();
    // Scale about the centre (130, 30), from 10 units right of it to 20 (see the React test).
    pointer(stage.querySelector('[id$="box"]')!, "pointerdown", 40, -20);
    expect(controller.getState().recording?.gesture?.mode).toBe("scale");
    await clock.advance(200);
    pointer(stage, "pointermove", 50, -20);
    pointer(stage, "pointerup", 50, -20);
    target.querySelector<HTMLButtonElement>("[data-record-stop]")!.click();
    flushSync();
    const run = controller.getScene().shots[1].run;
    expect(run.map((c) => c.type).sort()).toEqual(["scale", "style"]);
    expect(run.find((c) => c.type === "style")).toMatchObject({ fill: "#0ea5e9", duration: 0 });
    expect(run.find((c) => c.type === "scale")).toMatchObject({ to: 2, duration: 200 });
  });

  it("cancels without changing the scene and hides Record when read-only", () => {
    const controller = new AnimationEditorController({ scene: SCENE, clock: new ManualClock() });
    const { target } = render(AnimationEditor, { controller });
    target.querySelector<HTMLButtonElement>("[data-record-start]")!.click();
    flushSync();
    target.querySelector<HTMLButtonElement>("[data-record-cancel]")!.click();
    flushSync();
    expect(controller.getState().recording).toBeNull();
    expect(controller.getScene().shots).toHaveLength(1);
    controller.setReadOnly(true);
    flushSync();
    expect(target.querySelector("[data-record-start]")).toBeNull();
  });
});
