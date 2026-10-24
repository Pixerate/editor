import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { GradientController, createGradient } from "@pixerate/editor/gradient";
import { GradientEditor, FillPicker } from "../src/gradient";

let cleanups: (() => void)[] = [];

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
});

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

describe("Svelte GradientEditor", () => {
  it("renders the stops of a controller", () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });

    const { target } = render(GradientEditor, { controller });

    const stopButtons = target.querySelectorAll('[role="slider"]');
    // At least 3 stops and 1 angle dial = 4 sliders
    expect(stopButtons.length).toBeGreaterThanOrEqual(3);

    const s1 = target.querySelector(`[data-testid="gradient-stop-${grad.stops[0].id}"]`);
    const s2 = target.querySelector(`[data-testid="gradient-stop-${grad.stops[1].id}"]`);
    const s3 = target.querySelector(`[data-testid="gradient-stop-${grad.stops[2].id}"]`);
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();
  });

  it("clicking the track adds a stop (one undo step)", () => {
    const grad = createGradient(["#ff0000", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    expect(controller.getGradient().stops.length).toBe(2);

    const { target } = render(GradientEditor, { controller });

    const track = target.querySelector('[data-testid="gradient-track"]') as HTMLDivElement;
    expect(track).not.toBeNull();

    // Mock getBoundingClientRect
    track.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 24,
      right: 200,
      bottom: 24,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    track.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 }));
    flushSync();

    expect(controller.getGradient().stops.length).toBe(3);
    expect(controller.state.canUndo).toBe(true);

    controller.undo();
    flushSync();
    expect(controller.getGradient().stops.length).toBe(2);
  });

  it("ArrowRight on a stop moves it 1%", () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    const s2 = grad.stops[1];
    expect(s2.offset).toBe(0.5);

    const { target } = render(GradientEditor, { controller });

    const stopEl = target.querySelector(`[data-testid="gradient-stop-${s2.id}"]`) as HTMLButtonElement;
    expect(stopEl).not.toBeNull();

    stopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();

    const updatedStop = controller.getGradient().stops.find((s) => s.id === s2.id);
    expect(updatedStop?.offset).toBe(0.51);
  });

  it("Delete removes a stop, but not when only 2 are left", () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    const s2 = grad.stops[1];

    const { target } = render(GradientEditor, { controller });

    const stopEl = target.querySelector(`[data-testid="gradient-stop-${s2.id}"]`) as HTMLButtonElement;
    stopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    flushSync();

    expect(controller.getGradient().stops.length).toBe(2);
    expect(controller.getGradient().stops.some((s) => s.id === s2.id)).toBe(false);

    // Try deleting when only 2 remain
    const remainingFirst = controller.getGradient().stops[0];
    const firstStopEl = target.querySelector(`[data-testid="gradient-stop-${remainingFirst.id}"]`) as HTMLButtonElement;
    if (firstStopEl) {
      firstStopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      flushSync();
    }
    expect(controller.getGradient().stops.length).toBe(2);
  });

  it("editing the colour of the selected stop updates the controller", () => {
    const grad = createGradient(["#ff0000", "#0000ff"]);
    const controller = new GradientController({ value: grad });

    const { target } = render(GradientEditor, { controller });

    const input = target.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "#00ff00");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();

    const currentStop = controller.getSelectedStop();
    expect(currentStop?.color.toLowerCase()).toBe("#00ff00");
  });
});

describe("Svelte FillPicker", () => {
  it("renders with modes=['solid'] having no gradient UI", () => {
    const { target } = render(FillPicker, {
      value: "#ff0000",
      onchange: () => {},
      modes: ["solid"],
    });

    expect(target.querySelector('[data-testid="gradient-editor"]')).toBeNull();
    expect(target.querySelector('[aria-label="Saturation and brightness"]')).not.toBeNull();
  });

  it("round-trips a CSS gradient value through onChange", () => {
    let currentValue = "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)";
    const handleChange = vi.fn((val: string) => {
      currentValue = val;
    });

    const { target } = render(FillPicker, {
      value: currentValue,
      onchange: handleChange,
    });

    // Should be in gradient mode
    expect(target.querySelector('[data-testid="gradient-editor"]')).not.toBeNull();

    // Trigger reverse on the gradient
    const reverseBtn = target.querySelector('button[aria-label="Reverse stops"]') as HTMLButtonElement;
    expect(reverseBtn).not.toBeNull();

    reverseBtn.click();
    flushSync();

    expect(handleChange).toHaveBeenCalled();
    expect(currentValue).toContain("linear-gradient(");
  });
});

describe("Svelte FillPicker as a controlled component", () => {
  function host(initial: string) {
    const calls: string[] = [];
    const gestures: string[] = [];
    const props = $state({
      value: initial,
      onchange: (v: string) => {
        calls.push(v);
        props.value = v;
      },
      ongesturestart: () => gestures.push("start"),
      ongestureend: () => gestures.push("end")
    });
    const { target } = render(FillPicker, props);
    const stops = () => [...target.querySelectorAll<HTMLButtonElement>('[data-testid^="gradient-stop-"]')];
    return { calls, gestures, props, target, stops };
  }

  it("reports gradient edits after switching from solid to gradient", () => {
    const { calls, target } = host("#ff0000");
    const gradientButton = [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Gradient")!;
    gradientButton.click();
    flushSync();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^linear-gradient\(/);

    (target.querySelector('button[aria-label="Reverse stops"]') as HTMLButtonElement).click();
    flushSync();
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toBe(calls[0]);
  });

  it("keeps the selected stop while its edits round-trip through the parent", () => {
    const { calls, stops } = host("linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)");
    stops()[1].click();
    flushSync();
    expect(stops()[1].getAttribute("aria-current")).toBe("true");
    for (let i = 0; i < 2; i++) {
      stops()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      flushSync();
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("#00ff00 52%");
    expect(stops()[1].getAttribute("aria-current")).toBe("true");
  });

  it("follows a new value from the parent without reporting it back", () => {
    const calls: string[] = [];
    const props = $state({ value: "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)", onchange: (v: string) => calls.push(v) });
    const { target } = render(FillPicker, props);
    props.value = "linear-gradient(90deg, #000000 0%, #888888 50%, #ffffff 100%)";
    flushSync();
    expect(target.querySelectorAll('[data-testid^="gradient-stop-"]')).toHaveLength(3);
    expect(calls).toHaveLength(0);
  });

  it("forwards gradient drag gestures to the host", () => {
    const { gestures, stops } = host("linear-gradient(90deg, #ff0000 0%, #0000ff 100%)");
    stops()[0].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    flushSync();
    expect(gestures).toEqual(["start"]);
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    flushSync();
    expect(gestures).toEqual(["start", "end"]);
  });

  it("passes showCss through to the gradient editor", () => {
    const { target } = render(FillPicker, { value: "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)", showCss: true });
    expect([...target.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Copy")).toBe(true);
  });
});
