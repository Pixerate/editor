// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CommandRegistry } from "@pixerate/editor/commands";
import { ParametersController, createParameterKeyframeStore, type ParameterSchema } from "@pixerate/editor/parameters";
import {
  KeyframeDiamond,
  ParameterColor,
  ParameterSelect,
  ParameterSlider,
  ParametersPanel,
  useParameterCommands,
  useParameters,
  useParametersController,
  type UseParametersResult,
} from "../src/parameters";

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

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const field = (id: string) => q(`[data-parameter-id="${id}"]`);

async function fire(el: Element, type: string, init: any = { bubbles: true }) {
  await act(async () => {
    const Ctor = type.startsWith("pointer") ? (win().PointerEvent ?? win().MouseEvent) : type === "focusout" ? win().FocusEvent : win().Event;
    el.dispatchEvent(new Ctor(type, init));
  });
}

async function setInput(input: HTMLInputElement | HTMLSelectElement, value: string, type = "input") {
  await act(async () => {
    const proto = input instanceof win().HTMLSelectElement ? win().HTMLSelectElement.prototype : win().HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new (win().Event)(type, { bubbles: true }));
  });
}

async function commit(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}

describe("useParameters", () => {
  it("follows the controller and binds actions", async () => {
    // A fixed random source: Math.random can land back on the default (speed 1), leaving nothing modified.
    const controller = new ParametersController({ schema, random: () => 0.75 });
    const ref: { result: UseParametersResult | null; renders: number } = { result: null, renders: 0 };
    function Test() {
      ref.result = useParameters(controller);
      ref.renders++;
      return <span data-speed="">{String(ref.result.values.speed)}</span>;
    }
    await act(async () => root.render(<Test />));
    expect(q("[data-speed]").textContent).toBe("1");
    await act(async () => void ref.result!.setValue("speed", 2));
    expect(q("[data-speed]").textContent).toBe("2");
    expect(ref.result!.state.canUndo).toBe(true);
    await act(async () => ref.result!.undo());
    expect(q("[data-speed]").textContent).toBe("1");
    await act(async () => ref.result!.randomize(["speed"]));
    expect(q("[data-speed]").textContent).toBe("3");
    expect(ref.result!.state.modified).toBe(true);
  });

  it("creates a controller once and follows schema changes", async () => {
    let seen: ParametersController[] = [];
    function Test({ s }: { s: ParameterSchema }) {
      const c = useParametersController({ schema: s });
      seen.push(c);
      return null;
    }
    await act(async () => root.render(<Test s={schema} />));
    const next: ParameterSchema = { fields: [{ id: "only", type: "boolean", default: true }] };
    await act(async () => root.render(<Test s={next} />));
    expect(new Set(seen).size).toBe(1);
    expect(seen[0].getValues()).toEqual({ only: true });
  });

  it("registers agent commands while mounted", async () => {
    const registry = new CommandRegistry();
    const controller = new ParametersController({ schema });
    function Test({ on }: { on: boolean }) {
      useParameterCommands(on ? registry : null, controller);
      return null;
    }
    await act(async () => root.render(<Test on />));
    expect(registry.has("parameters.set")).toBe(true);
    expect(registry.execute("parameters.set", { values: { speed: 2 } })).toMatchObject({ ok: true });
    expect(controller.getValue("speed")).toBe(2);
    await act(async () => root.render(<Test on={false} />));
    expect(registry.has("parameters.set")).toBe(false);
  });
});

describe("field controls", () => {
  it("merges a slider drag into one gesture", async () => {
    const onChange = vi.fn();
    const onGestureStart = vi.fn();
    const onGestureEnd = vi.fn();
    const f = schema.fields[0] as any;
    await act(async () =>
      root.render(<ParameterSlider field={f} value={1} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />),
    );
    const range = q<HTMLInputElement>('input[type="range"]');
    await fire(range, "pointerdown");
    await setInput(range, "2.5");
    await fire(range, "pointerup");
    expect(onGestureStart).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2.5);
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
    // The number box parses, clamps and commits on blur.
    await commit(q<HTMLInputElement>('input[aria-label="Speed value"]'), "9");
    expect(onChange).toHaveBeenLastCalledWith(4);
    // Text that is not a number shows the stored value again.
    onChange.mockClear();
    await commit(q<HTMLInputElement>('input[aria-label="Speed value"]'), "abc");
    expect(onChange).not.toHaveBeenCalled();
    expect(q<HTMLInputElement>('input[aria-label="Speed value"]').value).toBe("1");
  });

  it("renders segmented choices and colour hex input", async () => {
    const onChoice = vi.fn();
    const onColor = vi.fn();
    await act(async () =>
      root.render(
        <>
          <ParameterSelect field={{ id: "m", type: "choice", control: "segmented", options: ["a", "b"], default: "a" }} value="a" onChange={onChoice} />
          <ParameterColor field={{ id: "c", type: "color", alpha: true, default: "#ff000080", swatches: ["#00f"] }} value="#ff000080" onChange={onColor} />
        </>,
      ),
    );
    await click(container.querySelectorAll('[role="radio"]')[1]);
    expect(onChoice).toHaveBeenCalledWith("b");
    await commit(q<HTMLInputElement>('input[aria-label="C hex"]'), "#0F0");
    expect(onColor).toHaveBeenCalledWith("#00ff00ff");
    await click(q('button[aria-label="C #0000ffff"]'));
    expect(onColor).toHaveBeenLastCalledWith("#0000ffff");
    await setInput(q<HTMLInputElement>('input[aria-label="C opacity"]'), "255");
    expect(onColor).toHaveBeenLastCalledWith("#ff0000ff");
  });

  it("shows keyframe state on the diamond", async () => {
    const onToggle = vi.fn();
    await act(async () => root.render(<KeyframeDiamond state="keyed" label="Speed" onToggle={onToggle} />));
    const button = q("button");
    expect(button.getAttribute("aria-label")).toBe("Remove keyframe for Speed");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await click(button);
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("ParametersPanel", () => {
  it("renders the schema and edits values through the controller", async () => {
    const controller = new ParametersController({ schema, keyframes: createParameterKeyframeStore() });
    await act(async () => root.render(<ParametersPanel controller={controller} />));
    expect(q("h3").textContent).toBe("Glow");
    expect(field("speed")).not.toBeNull();
    // `extra` is hidden until mode is "hard".
    expect(q('[data-parameter-group="extra"]')).toBeNull();

    const range = field("speed").querySelector('input[type="range"]') as HTMLInputElement;
    await fire(range, "pointerdown");
    await setInput(range, "2");
    await setInput(range, "3");
    await fire(range, "pointerup");
    expect(controller.getValue("speed")).toBe(3);
    expect(controller.history.getState().undoCount).toBe(1);

    await click(field("grain").querySelector('[role="switch"]')!);
    expect(controller.getValue("grain")).toBe(false);

    await setInput(field("mode").querySelector("select")!, "1", "change");
    expect(controller.getValue("mode")).toBe("hard");
    expect(q('[data-parameter-group="extra"]')).not.toBeNull();

    await commit(field("center").querySelector('input[aria-label="Center y"]') as HTMLInputElement, "0.5");
    expect(controller.getValue("center")).toEqual([0, 0.5]);

    await click(field("photo").querySelector('button[aria-label="A"]')!);
    expect(controller.getValue("photo")).toBe("https://example.com/a.jpg");

    // Invalid text is refused and the sentence is shown.
    await commit(field("caption").querySelector("input") as HTMLInputElement, "NOPE");
    expect(controller.getValue("caption")).toBe("hi");
    expect(field("caption").querySelector('[role="alert"]')!.textContent).toBe("Caption must match the pattern [a-z ]*.");

    // Keyframe diamond toggles a key at the playhead.
    await click(field("speed").querySelector("[data-key-state]")!);
    expect(field("speed").querySelector("[data-key-state]")!.getAttribute("data-key-state")).toBe("keyed");

    // Per-field reset and toolbar undo.
    await click(field("grain").querySelector('button[aria-label="Reset Film grain"]')!);
    expect(controller.getValue("grain")).toBe(true);
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Undo")!);
    expect(controller.getValue("grain")).toBe(false);
  });

  it("collapses groups and manages presets", async () => {
    const controller = new ParametersController({ schema });
    await act(async () => root.render(<ParametersPanel controller={controller} />));
    const header = q('[data-parameter-group="look"] button');
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await click(header);
    expect(q('[data-parameter-group="look"] button').getAttribute("aria-expanded")).toBe("false");
    expect(field("tint")).toBeNull();

    await setInput(q<HTMLSelectElement>('select[aria-label="Preset"]'), "Punchy", "change");
    expect(controller.getValues()).toMatchObject({ speed: 3, mode: "hard" });

    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Save…")!);
    await setInput(q<HTMLInputElement>('input[aria-label="Preset name"]'), "Punchy");
    await act(async () => q("form").dispatchEvent(new (win().Event)("submit", { bubbles: true, cancelable: true })));
    expect(q('[data-parameter-presets] [role="alert"]').textContent).toBe('"Punchy" is a built-in preset; save under another name.');
    await act(async () => void controller.setValue("grain", false));
    await setInput(q<HTMLInputElement>('input[aria-label="Preset name"]'), "Mine");
    await act(async () => q("form").dispatchEvent(new (win().Event)("submit", { bubbles: true, cancelable: true })));
    expect(controller.getState().presets.map((p) => p.name)).toEqual(["Punchy", "Mine"]);
    // "Mine" equals the current values, so it is active and can be deleted.
    await click(q('button[aria-label="Delete preset Mine"]'));
    expect(controller.getState().presets.map((p) => p.name)).toEqual(["Punchy"]);
  });
});
