import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry } from "@pixerate/editor/commands";
import { ParametersController, createParameterKeyframeStore, parameterThemeStyleText, type ParameterSchema } from "@pixerate/editor/parameters";
import {
  KeyframeDiamond,
  ParameterColor,
  ParameterSelect,
  ParameterSlider,
  ParametersPanel,
  createParameters,
  useParameterCommands,
  parameterButtonStyle,
  parameterInputStyle,
} from "../src/parameters";
import { imageEditorParameterComponents } from "../src/image-editor/controls/parameterControls";
import ImageParameterControlsProbe from "./fixtures/ImageParameterControlsProbe.svelte";
import CustomParameterInput from "./fixtures/CustomParameterInput.svelte";
import CustomParameterSlider from "./fixtures/CustomParameterSlider.svelte";
import CustomParameterSelect from "./fixtures/CustomParameterSelect.svelte";
import ParameterComponentsProbe from "./fixtures/ParameterComponentsProbe.svelte";

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

const fire = (el: Element, type: string, init?: any) => {
  const Ctor = type.startsWith("key") ? KeyboardEvent : Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
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
    // A fixed random source: Math.random can land back on the default (speed 1), leaving nothing modified.
    const controller = new ParametersController({ schema, random: () => 0.75 });
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
    expect(params.values.speed).toBe(3);
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
    // Text that is not a number shows the stored value again.
    onchange.mockClear();
    commit(root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement, "abc");
    expect(onchange).not.toHaveBeenCalled();
    expect((root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement).value).toBe("1");
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

    // Open the color picker popover via the swatch button
    click(b.querySelector('button[aria-label="C"]')!);

    // Use alpha slider inside the ColorPicker
    const alphaSlider = b.querySelector('[role="slider"][aria-label="Alpha"]')!;
    fire(alphaSlider, "keydown", { key: "End" });
    expect(onColor).toHaveBeenLastCalledWith("#ff0000ff");

    // Click the swatch button inside the ColorPicker
    click(b.querySelector('button[title="#00f"]')!);
    expect(onColor).toHaveBeenLastCalledWith("#00f");
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

  it("commits on Tab and deduplicates with subsequent blur", () => {
    const onchange = vi.fn();
    const root = render(ParameterSlider, { field: schema.fields[0], value: 1, onchange });
    const input = root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement;
    input.value = "2.5";
    // Press Tab
    fire(input, "keydown", { key: "Tab" });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(2.5);

    // Immediate blur should not trigger duplicate commit
    fire(input, "blur");
    expect(onchange).toHaveBeenCalledTimes(1);
  });

  it("commits on native change event and resets on Escape", () => {
    const onchange = vi.fn();
    const root = render(ParameterSlider, { field: schema.fields[0], value: 1, onchange });
    const input = root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement;
    input.value = "3.2";
    fire(input, "change");
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(3.2);

    // Escape resets draft back to current value
    input.value = "99";
    fire(input, "keydown", { key: "Escape" });
    expect(input.value).toBe("1");
  });

  it("renders with host parameter fallback styling tokens", () => {
    const root = render(ParameterSlider, { field: schema.fields[0], value: 1, onchange: () => {} });
    const input = root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement;
    expect(input.getAttribute("style")).toContain("var(--pixerate-parameter-input-bg");
    const range = root.querySelector('input[type="range"]') as HTMLInputElement;
    expect(range.getAttribute("style")).toContain("var(--pixerate-parameter-accent");
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

  it("renders custom components passed via components prop", () => {
    const controller = new ParametersController({ schema });
    const root = render(ParametersPanel, {
      controller,
      components: { input: CustomParameterInput, slider: CustomParameterSlider, select: CustomParameterSelect },
    });
    expect(root.querySelector('[data-testid="custom-slider"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="custom-input"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="custom-select"]')).not.toBeNull();
  });

  it("renders custom components provided via context", () => {
    const controller = new ParametersController({ schema });
    const root = render(ParameterComponentsProbe, {
      controller,
      components: { input: CustomParameterInput },
    });
    expect(root.querySelector('[data-testid="custom-input"]')).not.toBeNull();
  });
});

describe("parameter control fixes", () => {
  it("reverts refused text every time it is committed, not only the first", () => {
    const onchange = vi.fn();
    const root = render(ParameterSlider, { field: schema.fields[0], value: 4, onchange });
    const input = root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement;
    for (const attempt of [1, 2]) {
      input.value = "99"; // clamps to the stored 4
      fire(input, "keydown", { key: "Enter" });
      expect(input.value, `attempt ${attempt}`).toBe("4");
    }
    commit(input, "abc");
    commit(input, "abc");
    expect(input.value).toBe("4");
    expect(onchange).not.toHaveBeenCalled();
  });

  it("commits once on Tab in a panel and keeps the element", () => {
    const controller = new ParametersController({ schema });
    const root = render(ParametersPanel, { controller });
    const input = root.querySelector('input[aria-label="Speed value"]') as HTMLInputElement;
    input.value = "2.5";
    fire(input, "keydown", { key: "Tab" });
    fire(input, "blur");
    expect(controller.getState().values.speed).toBe(2.5);
    expect(root.querySelector('input[aria-label="Speed value"]')).toBe(input);
    controller.undo();
    expect(controller.getState().canUndo).toBe(false);
  });

  it("maps a string-only custom select back to the option's numeric value", () => {
    const onchange = vi.fn();
    const field = { id: "radius", type: "choice", options: [1, 2, 4], default: 1 };
    const root = render(ParameterSelect, { field, value: 1, onchange, components: { select: CustomParameterSelect } });
    setInput(root.querySelector('[data-testid="custom-select"]') as HTMLSelectElement, "4", "change");
    expect(onchange).toHaveBeenCalledWith(4);
  });

  it("commits through a custom input's oncommit", () => {
    const onchange = vi.fn();
    const root = render(ParameterSlider, { field: schema.fields[0], value: 1, onchange, components: { input: CustomParameterInput } });
    setInput(root.querySelector('[data-testid="custom-input"]') as HTMLInputElement, "3", "change");
    expect(onchange).toHaveBeenCalledWith(3);
  });

  it("starts one gesture per drag from a custom slider", () => {
    const ongesturestart = vi.fn();
    const ongestureend = vi.fn();
    const onchange = vi.fn();
    const root = render(ParameterSlider, {
      field: schema.fields[0],
      value: 1,
      onchange,
      ongesturestart,
      ongestureend,
      components: { slider: CustomParameterSlider },
    });
    const slider = root.querySelector('[data-testid="custom-slider"]') as HTMLInputElement;
    fire(slider, "pointerdown");
    fire(slider, "pointerdown");
    setInput(slider, "2");
    fire(slider, "pointerup");
    expect(ongesturestart).toHaveBeenCalledTimes(1);
    expect(ongestureend).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(2);
  });

  it("uses the image editor's host Select through the adapter, with typed values", () => {
    const onchange = vi.fn();
    const field = { id: "radius", type: "choice", options: [1, 2, 4], default: 1 };
    const root = render(ImageParameterControlsProbe, { field, value: 1, onchange });
    setInput(root.querySelector('[data-testid="host-select"]') as HTMLSelectElement, "2", "change");
    expect(onchange).toHaveBeenCalledWith(2);
    expect(imageEditorParameterComponents({})).toEqual({ slider: undefined, select: undefined });
  });

  it("themes buttons without an inline background, with the same tokens as React", () => {
    expect(parameterButtonStyle).not.toContain("background-color");
    expect(parameterInputStyle).toBe(parameterThemeStyleText("input"));
    const controller = new ParametersController({ schema });
    controller.setValue("speed", 3);
    const root = render(ParametersPanel, { controller });
    expect(root.querySelector('button[aria-label="Reset Speed"]')!.getAttribute("style")).toBeNull();
    const undo = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Undo")!;
    expect(undo.getAttribute("style")).toContain("--pixerate-parameter-button-fg");
    expect(undo.getAttribute("style")).not.toContain("background-color");
  });
});
