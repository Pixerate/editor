import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry } from "@pixerate/editor/commands";
import { ParametersController, createParameterKeyframeStore, type ParameterSchema } from "@pixerate/editor/parameters";
import {
  KeyframeDiamond,
  ParameterColor,
  ParameterSelect,
  ParameterSlider,
  ParametersPanel,
  createParameters,
  useParameterCommands,
} from "../src/parameters";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

const schema: ParameterSchema = {
  title: "Glow",
  fields: [
    { id: "speed", type: "number", label: "Speed", min: 0, max: 4, step: 0.1, default: 1 },
    { id: "grain", type: "boolean", label: "Film grain", default: true },
    { id: "mode", type: "choice", options: ["soft", "hard"], default: "soft" },
    {
      type: "group",
      id: "look",
      label: "Look",
      fields: [
        { id: "tint", type: "color", default: "#77c16a" },
        { id: "center", type: "vector", size: 2, min: -1, max: 1, default: [0, 0] },
        { id: "photo", type: "image", default: "", options: [{ url: "https://example.com/a.jpg", label: "A" }] },
        { id: "caption", type: "text", default: "hi", pattern: "[a-z ]*" },
      ],
    },
    { type: "group", id: "extra", label: "Extra", showIf: { mode: "hard" }, fields: [{ id: "edge", type: "int", min: 0, max: 8, default: 2 }] },
  ],
  presets: [{ name: "Punchy", values: { speed: 3, mode: "hard" } }],
};

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

const fire = (el: Element, type: string) => {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  flushSync();
};
const setInput = (el: HTMLInputElement | HTMLSelectElement, value: string, type = "input") => {
  el.value = value;
  fire(el, type);
};
const commit = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new FocusEvent("blur"));
  flushSync();
};
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};

describe("createParameters", () => {
  it("follows the controller and binds actions", () => {
    const controller = new ParametersController({ schema });
    const params = createParameters(controller);
    cleanups.push(params.destroy);
    expect(params.values.speed).toBe(1);
    params.setValue("speed", 2);
    expect(params.state).toBe(controller.getState());
    expect(params.values.speed).toBe(2);
    expect(params.state.canUndo).toBe(true);
    params.undo();
    expect(params.values.speed).toBe(1);
    params.randomize(["speed"]);
    expect(params.state.modified).toBe(true);
    const own = createParameters({ schema });
    cleanups.push(own.destroy);
    expect(own.controller).toBeInstanceOf(ParametersController);
  });

  it("registers agent commands for the component's lifetime", () => {
    const registry = new CommandRegistry();
    const controller = new ParametersController({ schema });
    const stop = $effect.root(() => {
      useParameterCommands(registry, controller);
    });
    flushSync();
    expect(registry.has("parameters.set")).toBe(true);
    expect(registry.execute("parameters.set", { values: { speed: 2 } })).toMatchObject({ ok: true });
    expect(controller.getValue("speed")).toBe(2);
    stop();
    expect(registry.has("parameters.set")).toBe(false);
  });
});

describe("field controls", () => {
  it("merges a slider drag into one gesture", () => {
    const onchange = vi.fn();
    const ongesturestart = vi.fn();
    const ongestureend = vi.fn();
    const root = render(ParameterSlider, { field: schema.fields[0], value: 1, onchange, ongesturestart, ongestureend });
    const range = root.querySelector('input[type="range"]') as HTMLInputElement;
    fire(range, "pointerdown");
    setInput(range, "2.5");
    fire(range, "pointerup");
    expect(ongesturestart).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(2.5);
    expect(ongestureend).toHaveBeenCalledTimes(1);
    commit(root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement, "9");
    expect(onchange).toHaveBeenLastCalledWith(4);
  });

  it("renders segmented choices and colour hex input", () => {
    const onChoice = vi.fn();
    const onColor = vi.fn();
    const a = render(ParameterSelect, {
      field: { id: "m", type: "choice", control: "segmented", options: ["a", "b"], default: "a" },
      value: "a",
      onchange: onChoice,
    });
    click(a.querySelectorAll('[role="radio"]')[1]);
    expect(onChoice).toHaveBeenCalledWith("b");
    const b = render(ParameterColor, {
      field: { id: "c", type: "color", alpha: true, default: "#ff000080", swatches: ["#00f"] },
      value: "#ff000080",
      onchange: onColor,
    });
    commit(b.querySelector('input[aria-label="C hex"]') as HTMLInputElement, "#0F0");
    expect(onColor).toHaveBeenCalledWith("#00ff00ff");
    click(b.querySelector('button[aria-label="C #0000ffff"]'));
    expect(onColor).toHaveBeenLastCalledWith("#0000ffff");
    setInput(b.querySelector('input[aria-label="C opacity"]') as HTMLInputElement, "255");
    expect(onColor).toHaveBeenLastCalledWith("#ff0000ff");
  });

  it("shows keyframe state on the diamond", () => {
    const ontoggle = vi.fn();
    const root = render(KeyframeDiamond, { state: "keyed", label: "Speed", ontoggle });
    const button = root.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Remove keyframe for Speed");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    click(button);
    expect(ontoggle).toHaveBeenCalled();
  });
});

describe("ParametersPanel", () => {
  it("renders the schema and edits values through the controller", () => {
    const controller = new ParametersController({ schema, keyframes: createParameterKeyframeStore() });
    const root = render(ParametersPanel, { controller });
    const field = (id: string) => root.querySelector(`[data-parameter-id="${id}"]`) as HTMLElement;
    expect(root.querySelector("h3")!.textContent).toBe("Glow");
    expect(root.querySelector('[data-parameter-group="extra"]')).toBeNull();

    const range = field("speed").querySelector('input[type="range"]') as HTMLInputElement;
    fire(range, "pointerdown");
    setInput(range, "2");
    setInput(range, "3");
    fire(range, "pointerup");
    expect(controller.getValue("speed")).toBe(3);
    expect(controller.history.getState().undoCount).toBe(1);

    click(field("grain").querySelector('[role="switch"]'));
    expect(controller.getValue("grain")).toBe(false);

    setInput(field("mode").querySelector("select")!, "1", "change");
    expect(controller.getValue("mode")).toBe("hard");
    expect(root.querySelector('[data-parameter-group="extra"]')).not.toBeNull();

    commit(field("center").querySelector('input[aria-label="Center y"]') as HTMLInputElement, "0.5");
    expect(controller.getValue("center")).toEqual([0, 0.5]);

    click(field("photo").querySelector('button[aria-label="A"]'));
    expect(controller.getValue("photo")).toBe("https://example.com/a.jpg");

    commit(field("caption").querySelector("input") as HTMLInputElement, "NOPE");
    expect(controller.getValue("caption")).toBe("hi");
    expect(field("caption").querySelector('[role="alert"]')!.textContent).toBe("Caption must match the pattern [a-z ]*.");

    click(field("speed").querySelector("[data-key-state]"));
    expect(field("speed").querySelector("[data-key-state]")!.getAttribute("data-key-state")).toBe("keyed");

    click(field("grain").querySelector('button[aria-label="Reset Film grain"]'));
    expect(controller.getValue("grain")).toBe(true);
    click([...root.querySelectorAll("button")].find((b) => b.textContent === "Undo")!);
    expect(controller.getValue("grain")).toBe(false);
  });

  it("collapses groups and manages presets", () => {
    const controller = new ParametersController({ schema });
    const root = render(ParametersPanel, { controller });
    const header = root.querySelector('[data-parameter-group="look"] button')!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    click(header);
    expect(root.querySelector('[data-parameter-group="look"] button')!.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector('[data-parameter-id="tint"]')).toBeNull();

    setInput(root.querySelector('select[aria-label="Preset"]') as HTMLSelectElement, "Punchy", "change");
    expect(controller.getValues()).toMatchObject({ speed: 3, mode: "hard" });

    click([...root.querySelectorAll("button")].find((b) => b.textContent === "Save…")!);
    setInput(root.querySelector('input[aria-label="Preset name"]') as HTMLInputElement, "Punchy");
    fire(root.querySelector("form")!, "submit");
    expect(root.querySelector('[data-parameter-presets] [role="alert"]')!.textContent).toBe(
      '"Punchy" is a built-in preset; save under another name.',
    );
    controller.setValue("grain", false);
    flushSync();
    setInput(root.querySelector('input[aria-label="Preset name"]') as HTMLInputElement, "Mine");
    fire(root.querySelector("form")!, "submit");
    expect(controller.getState().presets.map((p) => p.name)).toEqual(["Punchy", "Mine"]);
    click(root.querySelector('button[aria-label="Delete preset Mine"]'));
    expect(controller.getState().presets.map((p) => p.name)).toEqual(["Punchy"]);
  });
});
