// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, EasePicker } from "../src/animation-editor";

const square = (x: number) => [{ closed: true, anchors: [{ x, y: 10 }, { x: x + 40, y: 10 }, { x: x + 40, y: 50 }, { x, y: 50 }] }];
const SCENE: MotionScene = {
  version: 1,
  name: "demo",
  artwork: {
    width: 200,
    height: 100,
    nodes: [
      { id: "box", type: "path", fill: "#ef4444", subpaths: square(10) },
      { id: "dot", type: "path", fill: "#0ea5e9", subpaths: square(120) },
    ],
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

const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const $$ = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
const run = (c: AnimationEditorController, shot = "intro") => c.getState().scene.shots.find((s) => s.id === shot)!.run;
function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
/** Types into a commit-on-blur input and leaves it. */
function commit(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus();
    el.value = value;
    el.blur();
  });
}
const field = (name: string) => $<HTMLInputElement>(`[data-command-inspector] [data-field="${name}"] input`);

describe("animation editor controls (React)", () => {
  it("adds, edits, reorders, duplicates and deletes commands, each one undo step", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => $<HTMLButtonElement>('[data-shot="intro"]').click());
    expect($$("[data-command-list] [data-command]")).toHaveLength(1);

    // Add a pulse after the selected command: it takes the same targets and is selected.
    act(() => $$("[data-command-list] [data-command]")[0].click());
    change($<HTMLSelectElement>('select[aria-label="New command type"]'), "pulse");
    act(() => $<HTMLButtonElement>("[data-add-command]").click());
    expect(run(controller)).toEqual([SCENE.shots[0].run[0], { type: "pulse", targets: ["box"] }]);
    expect(controller.getState().selection).toEqual({ shot: "intro", command: 1 });
    expect($("[data-command-inspector]").dataset.commandType).toBe("pulse");
    expect($("[data-command-inspector] [data-flair-primitive]").textContent).toBe("emphasis.pulse");
    expect($('[data-command-list] [data-command="1"] [data-flair-primitive]').textContent).toBe("emphasis.pulse");

    // The inspector's fields come from the schema, with units; bad input says why and changes nothing.
    expect($('[data-field="duration"]').textContent).toContain("ms");
    commit(field("count"), "3");
    expect(run(controller)[1]).toMatchObject({ count: 3 });
    commit(field("count"), "1.5");
    expect($("[data-command-inspector] [data-edit-error]").textContent).toMatch(/whole number/);
    expect(run(controller)[1]).toMatchObject({ count: 3 });
    change($<HTMLSelectElement>('[data-field="blend"] select'), "replace");
    expect(run(controller)[1]).toMatchObject({ blend: "replace" });

    // with and delay inline.
    change($<HTMLSelectElement>('[data-command="1"] select[aria-label="Starts"]'), "previous");
    commit($<HTMLInputElement>('[data-command="1"] input[aria-label="Delay"]'), "200");
    expect(run(controller)[1]).toMatchObject({ with: "previous", delay: 200 });
    commit($<HTMLInputElement>('[data-command="1"] input[aria-label="Delay"]'), "");
    expect(run(controller)[1].delay).toBeUndefined();

    // Reorder, duplicate, delete.
    act(() => $<HTMLButtonElement>('[data-command="1"] button[aria-label="Move up"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "enter"]);
    expect(controller.getState().selection).toEqual({ shot: "intro", command: 0 });
    act(() => $<HTMLButtonElement>('[data-command="0"] button[aria-label="Duplicate"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse", "enter"]);
    act(() => $<HTMLButtonElement>('[data-command="2"] button[aria-label="Delete"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse"]);

    // Undo walks back one edit at a time, through the toolbar and the keyboard.
    act(() => $<HTMLButtonElement>("[data-undo]").click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse", "enter"]);
    act(() => $("[data-animation-editor]").dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })));
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "enter"]);
    act(() => $<HTMLButtonElement>("[data-redo]").click());
    expect(run(controller)).toHaveLength(3);
    controller.destroy();
  });

  it("shows why an edit was refused", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => controller.select({ shot: "intro", command: 0 }));
    change($<HTMLSelectElement>('select[aria-label="New command type"]'), "effect");
    act(() => $<HTMLButtonElement>("[data-add-command]").click());
    expect($("[data-command-list] [data-edit-error]").textContent).toMatch(/Effect needs a target with a live path effect/);
    act(() => void controller.apply({ op: "delete_commands", shot: "intro", commands: [7] }));
    expect($("[data-command-list] [data-edit-error]").textContent).toMatch(/no command 7/);
    expect(run(controller)).toHaveLength(1);
    controller.destroy();
  });

  it("scrubs the playhead by dragging the ruler and with the keyboard", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    const track = $("[data-scrub-track]");
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, buttons: 1 })));
    expect(controller.getState().time).toBe(400);
    act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 150, buttons: 1 })));
    expect(controller.getState().time).toBe(600);
    expect($("[data-playhead]").style.left).toBe("75%");
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(controller.getState().time).toBe(500);
    change($<HTMLSelectElement>('[data-playhead-scrubber] select[aria-label="Loop"]'), "ping-pong");
    expect(controller.getState().scene.loop).toBe("ping-pong");
    expect(controller.getState().loop).toBe("ping-pong");
    controller.destroy();
  });

  it("picks elements on the stage and toggles them as targets", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => controller.select({ shot: "intro", command: 0 }));
    const dot = () => $("[data-animation-stage] #dot");
    act(() => dot().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect($("[data-picked-element]").dataset.pickedElement).toBe("dot");
    expect(dot().hasAttribute("data-picked")).toBe(true);
    act(() => $<HTMLButtonElement>("[data-add-picked]").click());
    expect(run(controller)[0].targets).toEqual(["box", "dot"]);
    act(() => dot().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(run(controller)[0].targets).toEqual(["box"]);
    controller.destroy();
  });

  it("previews easings and sets spring presets", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => controller.select({ shot: "away", command: 0 }));
    change($<HTMLSelectElement>('[data-field="ease"] select'), "spring-bouncy");
    expect(run(controller, "away")[0].ease).toBe("spring-bouncy");
    const curve = $("[data-field='ease'] [data-ease-curve]");
    expect(curve.getAttribute("data-ease-curve")).toBe("spring-bouncy");
    expect(curve.querySelector("path")!.getAttribute("d")).toMatch(/^M4 /);
    expect($("[data-field='ease']").textContent).toMatch(/\d+ ms/);
    change($<HTMLSelectElement>('[data-field="ease"] select'), "");
    expect(run(controller, "away")[0].ease).toBeUndefined();
    controller.destroy();
  });

  it("renders an ease picker on its own", () => {
    const picked: unknown[] = [];
    act(() => root.render(<EasePicker value="ease-out-back" onChange={(e) => picked.push(e)} />));
    expect($("[data-ease-curve]").getAttribute("data-ease-curve")).toBe("ease-out-back");
    change($<HTMLSelectElement>("select"), "linear");
    expect(picked).toEqual(["linear"]);
  });

  it("edits shots and scene settings: cue to a beat, fit to a length", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    act(() => root.render(<AnimationEditor controller={controller} />));
    act(() => controller.select({ shot: "away" }));
    commit($<HTMLInputElement>('input[aria-label="BPM"]'), "120");
    expect(controller.getState().scene.beat).toEqual({ bpm: 120 });
    change($<HTMLSelectElement>('select[aria-label="Cue"]'), "beat:2");
    expect(controller.getState().scene.shots[1].at).toEqual({ beat: 2 });
    expect(controller.getState().shots[1].start).toBe(1000);
    expect($$("[data-ruler] [data-beat]").length).toBeGreaterThan(2);
    change($<HTMLSelectElement>('select[aria-label="Cue"]'), "");
    commit($<HTMLInputElement>('input[aria-label="Shot label"]'), "Box leaves");
    expect(controller.getState().scene.shots[1].label).toBe("Box leaves");
    change($<HTMLInputElement>('input[aria-label="Fit to"]'), "1.6");
    act(() => $<HTMLButtonElement>("[data-fit]").click());
    expect(controller.getState().duration).toBeCloseTo(1600, -1);
    act(() => controller.undo());
    expect(controller.getState().duration).toBe(800);
    act(() => $<HTMLButtonElement>("[data-add-shot]").click());
    expect(controller.getState().scene.shots.map((s) => s.id)).toEqual(["intro", "away", "shot"]);
    change($<HTMLSelectElement>('select[aria-label="Scene trigger"]'), "click");
    expect(controller.getState().scene.trigger).toBe("click");
    expect(controller.toFlairMotion().motion.animate?.some((a) => a.step === 1)).toBe(true);
    change($<HTMLSelectElement>('select[aria-label="Scene trigger"]'), "");
    expect(controller.getState().scene.trigger).toBeUndefined();
    const drivers = $<HTMLTextAreaElement>('textarea[aria-label="Drivers"]');
    act(() => { drivers.value = "dot.x <- box.x * 0.5"; drivers.dispatchEvent(new FocusEvent("blur")); drivers.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(controller.getState().scene.drivers).toEqual([{ target: "dot", property: "x", source: { node: "box", property: "x" }, factor: 0.5 }]);
    controller.destroy();
  });
});
