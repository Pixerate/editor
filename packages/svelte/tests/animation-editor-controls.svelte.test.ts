import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, EasePicker } from "../src/animation-editor";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
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

const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const qa = (sel: string) => [...target.querySelectorAll(sel)] as HTMLElement[];
const run = (c: AnimationEditorController, shot = "intro") => c.getState().scene.shots.find((s) => s.id === shot)!.run;
const act = (fn: () => void) => {
  fn();
  flushSync();
};
/** Sets a value and fires `change` (what a select or a committed input does). */
function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function type(el: HTMLInputElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const field = (name: string) => q<HTMLInputElement>(`[data-command-inspector] [data-field="${name}"] input`);

describe("animation editor controls (Svelte)", () => {
  it("adds, edits, reorders, duplicates and deletes commands, each one undo step", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    act(() => q<HTMLButtonElement>('[data-shot="intro"]').click());
    expect(qa("[data-command-list] [data-command]")).toHaveLength(1);

    act(() => qa("[data-command-list] [data-command]")[0].click());
    change(q<HTMLSelectElement>('select[aria-label="New command type"]'), "pulse");
    act(() => q<HTMLButtonElement>("[data-add-command]").click());
    expect(run(controller)).toEqual([SCENE.shots[0].run[0], { type: "pulse", targets: ["box"] }]);
    expect(controller.getState().selection).toEqual({ shot: "intro", command: 1 });
    expect(q("[data-command-inspector]").dataset.commandType).toBe("pulse");
    expect(q("[data-command-inspector] [data-flair-primitive]").textContent).toBe("emphasis.pulse");
    expect(q('[data-command-list] [data-command="1"] [data-flair-primitive]').textContent).toBe("emphasis.pulse");

    expect(q('[data-field="duration"]').textContent).toContain("ms");
    change(field("count"), "3");
    expect(run(controller)[1]).toMatchObject({ count: 3 });
    change(field("count"), "1.5");
    expect(q("[data-command-inspector] [data-edit-error]").textContent).toMatch(/whole number/);
    expect(run(controller)[1]).toMatchObject({ count: 3 });
    change(q<HTMLSelectElement>('[data-field="blend"] select'), "replace");
    expect(run(controller)[1]).toMatchObject({ blend: "replace" });

    change(q<HTMLSelectElement>('[data-command="1"] select[aria-label="Starts"]'), "previous");
    change(q<HTMLInputElement>('[data-command="1"] input[aria-label="Delay"]'), "200");
    expect(run(controller)[1]).toMatchObject({ with: "previous", delay: 200 });
    change(q<HTMLInputElement>('[data-command="1"] input[aria-label="Delay"]'), "");
    expect(run(controller)[1].delay).toBeUndefined();

    act(() => q<HTMLButtonElement>('[data-command="1"] button[aria-label="Move up"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "enter"]);
    expect(controller.getState().selection).toEqual({ shot: "intro", command: 0 });
    act(() => q<HTMLButtonElement>('[data-command="0"] button[aria-label="Duplicate"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse", "enter"]);
    act(() => q<HTMLButtonElement>('[data-command="2"] button[aria-label="Delete"]').click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse"]);

    act(() => q<HTMLButtonElement>("[data-undo]").click());
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "pulse", "enter"]);
    act(() => q("[data-animation-editor]").dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })));
    expect(run(controller).map((c) => c.type)).toEqual(["pulse", "enter"]);
    act(() => q<HTMLButtonElement>("[data-redo]").click());
    expect(run(controller)).toHaveLength(3);
    controller.destroy();
  });

  it("shows why an edit was refused", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    act(() => controller.select({ shot: "intro", command: 0 }));
    change(q<HTMLSelectElement>('select[aria-label="New command type"]'), "effect");
    act(() => q<HTMLButtonElement>("[data-add-command]").click());
    expect(q("[data-command-list] [data-edit-error]").textContent).toMatch(/Effect needs a target with a live path effect/);
    act(() => void controller.apply({ op: "delete_commands", shot: "intro", commands: [7] }));
    expect(q("[data-command-list] [data-edit-error]").textContent).toMatch(/no command 7/);
    expect(run(controller)).toHaveLength(1);
    controller.destroy();
  });

  it("scrubs the playhead by dragging the ruler and with the keyboard", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    const track = q("[data-scrub-track]");
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, buttons: 1 })));
    expect(controller.getState().time).toBe(400);
    act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 150, buttons: 1 })));
    expect(controller.getState().time).toBe(600);
    expect(q("[data-playhead]").style.left).toBe("75%");
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(controller.getState().time).toBe(500);
    change(q<HTMLSelectElement>('[data-playhead-scrubber] select[aria-label="Loop"]'), "ping-pong");
    expect(controller.getState().scene.loop).toBe("ping-pong");
    expect(controller.getState().loop).toBe("ping-pong");
    controller.destroy();
  });

  it("picks elements on the stage and toggles them as targets", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    act(() => controller.select({ shot: "intro", command: 0 }));
    const dot = () => q("[data-animation-stage] #dot");
    act(() => dot().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(q("[data-picked-element]").dataset.pickedElement).toBe("dot");
    expect(dot().hasAttribute("data-picked")).toBe(true);
    act(() => q<HTMLButtonElement>("[data-add-picked]").click());
    expect(run(controller)[0].targets).toEqual(["box", "dot"]);
    act(() => dot().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(run(controller)[0].targets).toEqual(["box"]);
    controller.destroy();
  });

  it("previews easings and sets spring presets", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    act(() => controller.select({ shot: "away", command: 0 }));
    change(q<HTMLSelectElement>('[data-field="ease"] select'), "spring-bouncy");
    expect(run(controller, "away")[0].ease).toBe("spring-bouncy");
    const curve = q("[data-field='ease'] [data-ease-curve]");
    expect(curve.getAttribute("data-ease-curve")).toBe("spring-bouncy");
    expect(curve.querySelector("path")!.getAttribute("d")).toMatch(/^M4 /);
    expect(q("[data-field='ease']").textContent).toMatch(/\d+ ms/);
    change(q<HTMLSelectElement>('[data-field="ease"] select'), "");
    expect(run(controller, "away")[0].ease).toBeUndefined();
    controller.destroy();
  });

  it("renders an ease picker on its own", () => {
    const picked: unknown[] = [];
    render(EasePicker, { value: "ease-out-back", onchange: (e: unknown) => picked.push(e) });
    expect(q("[data-ease-curve]").getAttribute("data-ease-curve")).toBe("ease-out-back");
    change(q<HTMLSelectElement>("select"), "linear");
    expect(picked).toEqual(["linear"]);
  });

  it("edits shots and scene settings: cue to a beat, fit to a length", () => {
    const controller = new AnimationEditorController({ scene: SCENE });
    render(AnimationEditor, { controller });
    act(() => controller.select({ shot: "away" }));
    change(q<HTMLInputElement>('input[aria-label="BPM"]'), "120");
    expect(controller.getState().scene.beat).toEqual({ bpm: 120 });
    change(q<HTMLSelectElement>('select[aria-label="Cue"]'), "beat:2");
    expect(controller.getState().scene.shots[1].at).toEqual({ beat: 2 });
    expect(controller.getState().shots[1].start).toBe(1000);
    expect(qa("[data-ruler] [data-beat]").length).toBeGreaterThan(2);
    change(q<HTMLSelectElement>('select[aria-label="Cue"]'), "");
    change(q<HTMLInputElement>('input[aria-label="Shot label"]'), "Box leaves");
    expect(controller.getState().scene.shots[1].label).toBe("Box leaves");
    type(q<HTMLInputElement>('input[aria-label="Fit to"]'), "1.6");
    act(() => q<HTMLButtonElement>("[data-fit]").click());
    expect(controller.getState().duration).toBeCloseTo(1600, -1);
    act(() => controller.undo());
    expect(controller.getState().duration).toBe(800);
    act(() => q<HTMLButtonElement>("[data-add-shot]").click());
    expect(controller.getState().scene.shots.map((s) => s.id)).toEqual(["intro", "away", "shot"]);
    change(q<HTMLSelectElement>('select[aria-label="Scene trigger"]'), "click");
    expect(controller.getState().scene.trigger).toBe("click");
    expect(controller.toFlairMotion().motion.animate?.some((a) => a.step === 1)).toBe(true);
    change(q<HTMLSelectElement>('select[aria-label="Scene trigger"]'), "");
    expect(controller.getState().scene.trigger).toBeUndefined();
    change(q<HTMLSelectElement>('select[aria-label="Motion blur"]'), "180");
    expect(controller.getState().scene.motionBlur).toEqual({ shutter: 180 });
    change(q<HTMLSelectElement>('select[aria-label="Motion blur"]'), "");
    expect(controller.getState().scene.motionBlur).toBeUndefined();
    change(q<HTMLTextAreaElement>('textarea[aria-label="Drivers"]'), "dot.x <- box.x * 0.5");
    expect(controller.getState().scene.drivers).toEqual([{ target: "dot", property: "x", source: { node: "box", property: "x" }, factor: 0.5 }]);
    controller.destroy();
  });
});
