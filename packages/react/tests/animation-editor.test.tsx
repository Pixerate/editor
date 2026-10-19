// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, useAnimationEditor, useAnimationEditorTools, type UseAnimationEditorResult } from "../src/animation-editor";

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

describe("AnimationEditor (React)", () => {
  it("draws the frame at the playhead and seeks by shot", async () => {
    const clock = new ManualClock();
    const controller = new AnimationEditorController({ scene: SCENE, clock });
    act(() => root.render(<AnimationEditor controller={controller} />));
    const stage = container.querySelector("[data-animation-stage]")!;
    expect(stage.querySelector("svg")).not.toBeNull();
    expect(stage.querySelector("#box")!.getAttribute("opacity")).toBe("0");
    const shots = container.querySelectorAll("[data-shot]");
    expect([...shots].map((s) => s.textContent)).toEqual(["Box arrives", "away"]);
    act(() => (shots[1] as HTMLButtonElement).click());
    expect(controller.getState().time).toBe(400);
    expect(controller.getState().selection).toEqual({ shot: "away" });
    expect(stage.querySelector("#box")!.getAttribute("opacity")).toBeNull();
    act(() => controller.play());
    await act(async () => clock.advance(400));
    expect(controller.getState().time).toBe(800);
    expect(stage.querySelector("#box")!.getAttribute("transform")).toContain("100");
    controller.destroy();
  });

  it("draws onion skin and motion paths on the stage", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    controller.seek(600);
    act(() => root.render(<AnimationEditor controller={controller} onionSkin={{ before: 2 }} motionPaths />));
    const stage = container.querySelector("[data-animation-stage]")!;
    expect(stage.querySelectorAll('[data-onion="before"]')).toHaveLength(2);
    expect(stage.querySelectorAll("#box")).toHaveLength(1);
    expect(stage.querySelector('[data-motion-path="box"] polyline')).not.toBeNull();
    controller.destroy();
  });

  it("marks shots with issues and lists them", () => {
    const controller = new AnimationEditorController({ scene: { ...SCENE, shots: [{ id: "bad", run: [{ type: "enter", targets: ["bx"] }] }] } });
    act(() => root.render(<AnimationEditor controller={controller} />));
    expect(container.querySelector('[data-shot="bad"]')!.getAttribute("data-issue")).toBe("error");
    expect(container.textContent).toContain('did you mean "box"');
    controller.destroy();
  });

  it("exposes state and registers agent tools while mounted", async () => {
    const registry = new ToolRegistry();
    let api: UseAnimationEditorResult | null = null;
    function Probe() {
      api = useAnimationEditor({ scene: SCENE });
      useAnimationEditorTools(registry, api.controller, { namespace: "anim" });
      return <span>{api.state.duration}</span>;
    }
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe("800");
    expect(registry.listTools().tools.map((t) => t.name)).toContain("anim__add_commands");
    const result = await act(async () => registry.callTool("anim__update_shot", { shot: "intro", set: { hold: 400 } }));
    expect(result.isError).toBeFalsy();
    expect(container.textContent).toBe("1200");
    act(() => api!.undo());
    expect(container.textContent).toBe("800");
    act(() => root.unmount());
    expect(registry.listTools().tools).toEqual([]);
    root = createRoot(container);
  });
});
