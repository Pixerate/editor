import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, createAnimationEditor } from "../src/animation-editor";
import ToolsProbe from "./fixtures/AnimationToolsProbe.svelte";

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
  shots: [
    { id: "intro", label: "Box arrives", run: [{ type: "enter", targets: ["box"], duration: 400 }], hold: 0 },
    { id: "away", run: [{ type: "move", targets: ["box"], by: { x: 100, y: 0 }, duration: 400 }], hold: 0 },
  ],
};

describe("AnimationEditor (Svelte)", () => {
  it("draws the frame at the playhead and seeks by shot", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    const { target } = render(AnimationEditor, { controller });
    const stage = target.querySelector("[data-animation-stage]")!;
    expect(stage.querySelector("#box")!.getAttribute("opacity")).toBe("0");
    const shots = target.querySelectorAll("[data-shot]");
    expect([...shots].map((s) => s.textContent!.trim())).toEqual(["Box arrives", "away"]);
    (shots[1] as HTMLButtonElement).click();
    flushSync();
    expect(controller.getState().time).toBe(400);
    expect(controller.getState().selection).toEqual({ shot: "away" });
    expect(stage.querySelector("#box")!.getAttribute("opacity")).toBeNull();
    controller.play();
    await clock.advance(400);
    flushSync();
    expect(stage.querySelector("#box")!.getAttribute("transform")).toContain("100");
    controller.destroy();
  });

  it("marks shots with issues and lists them", () => {
    const controller = new AnimationEditorController({ scene: { ...SCENE, shots: [{ id: "bad", run: [{ type: "enter", targets: ["bx"] }] }] } });
    const { target } = render(AnimationEditor, { controller });
    expect(target.querySelector('[data-shot="bad"]')!.getAttribute("data-issue")).toBe("error");
    expect(target.textContent).toContain('did you mean "box"');
    controller.destroy();
  });

  it("exposes reactive state through the rune", () => {
    const editor = createAnimationEditor({ scene: SCENE });
    expect(editor.state.duration).toBe(800);
    editor.controller.apply({ op: "update_shot", shot: "intro", set: { hold: 400 } });
    expect(editor.state.duration).toBe(1200);
    editor.undo();
    expect(editor.state.duration).toBe(800);
    editor.destroy();
  });

  it("registers agent tools while mounted", async () => {
    const registry = new ToolRegistry();
    const controller = new AnimationEditorController({ scene: SCENE });
    const { instance } = render(ToolsProbe, { registry, controller });
    expect(registry.listTools().tools.map((t) => t.name)).toContain("anim__add_commands");
    const result = await registry.callTool("anim__delete_shots", { shots: ["away"] });
    expect(result.isError).toBeFalsy();
    expect(controller.getState().scene.shots.map((s) => s.id)).toEqual(["intro"]);
    cleanups.pop()!();
    expect(registry.listTools().tools).toEqual([]);
    void instance;
    controller.destroy();
  });
});
