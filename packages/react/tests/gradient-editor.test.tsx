// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GradientController, createGradient } from "@pixerate/editor/gradient";
import { GradientEditor, FillPicker } from "../src/gradient";

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

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("React GradientEditor", () => {
  it("renders the stops of a controller", async () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });

    await act(async () => {
      root.render(<GradientEditor controller={controller} />);
    });

    const stopButtons = container.querySelectorAll('[role="slider"]');
    // At least 3 stops and 1 angle dial = 4 sliders
    expect(stopButtons.length).toBeGreaterThanOrEqual(3);

    const s1 = container.querySelector(`[data-testid="gradient-stop-${grad.stops[0].id}"]`);
    const s2 = container.querySelector(`[data-testid="gradient-stop-${grad.stops[1].id}"]`);
    const s3 = container.querySelector(`[data-testid="gradient-stop-${grad.stops[2].id}"]`);
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();
  });

  it("clicking the track adds a stop (one undo step)", async () => {
    const grad = createGradient(["#ff0000", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    expect(controller.getGradient().stops.length).toBe(2);

    await act(async () => {
      root.render(<GradientEditor controller={controller} />);
    });

    const track = container.querySelector('[data-testid="gradient-track"]') as HTMLDivElement;
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
      toJSON: () => {}
    });

    await act(async () => {
      track.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 }));
    });

    expect(controller.getGradient().stops.length).toBe(3);
    expect(controller.state.canUndo).toBe(true);

    await act(async () => {
      controller.undo();
    });
    expect(controller.getGradient().stops.length).toBe(2);
  });

  it("ArrowRight on a stop moves it 1%", async () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    const s2 = grad.stops[1];
    expect(s2.offset).toBe(0.5);

    await act(async () => {
      root.render(<GradientEditor controller={controller} />);
    });

    const stopEl = container.querySelector(`[data-testid="gradient-stop-${s2.id}"]`) as HTMLButtonElement;
    expect(stopEl).not.toBeNull();

    await act(async () => {
      stopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    const updatedStop = controller.getGradient().stops.find((s) => s.id === s2.id);
    expect(updatedStop?.offset).toBe(0.51);
  });

  it("Delete removes a stop, but not when only 2 are left", async () => {
    const grad = createGradient(["#ff0000", "#00ff00", "#0000ff"]);
    const controller = new GradientController({ value: grad });
    const s2 = grad.stops[1];

    await act(async () => {
      root.render(<GradientEditor controller={controller} />);
    });

    const stopEl = container.querySelector(`[data-testid="gradient-stop-${s2.id}"]`) as HTMLButtonElement;
    await act(async () => {
      stopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });

    expect(controller.getGradient().stops.length).toBe(2);
    expect(controller.getGradient().stops.some((s) => s.id === s2.id)).toBe(false);

    // Try deleting when only 2 remain
    const remainingFirst = controller.getGradient().stops[0];
    const firstStopEl = container.querySelector(`[data-testid="gradient-stop-${remainingFirst.id}"]`) as HTMLButtonElement;
    if (firstStopEl) {
      await act(async () => {
        firstStopEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      });
    }
    expect(controller.getGradient().stops.length).toBe(2);
  });

  it("editing the colour of the selected stop updates the controller", async () => {
    const grad = createGradient(["#ff0000", "#0000ff"]);
    const controller = new GradientController({ value: grad });

    await act(async () => {
      root.render(<GradientEditor controller={controller} />);
    });

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(input, "#00ff00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    const currentStop = controller.getSelectedStop();
    expect(currentStop?.color.toLowerCase()).toBe("#00ff00");
  });
});

describe("React FillPicker", () => {
  it("renders with modes=['solid'] having no gradient UI", async () => {
    await act(async () => {
      root.render(<FillPicker value="#ff0000" onChange={() => {}} modes={["solid"]} />);
    });

    expect(container.querySelector('[data-testid="gradient-editor"]')).toBeNull();
    expect(container.querySelector('[aria-label="Saturation and brightness"]')).not.toBeNull();
  });

  it("round-trips a CSS gradient value through onChange", async () => {
    let currentValue = "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)";
    const handleChange = vi.fn((val: string) => {
      currentValue = val;
    });

    await act(async () => {
      root.render(
        <FillPicker
          value={currentValue}
          onChange={handleChange}
        />
      );
    });

    // Should be in gradient mode
    expect(container.querySelector('[data-testid="gradient-editor"]')).not.toBeNull();

    // Trigger reverse on the gradient
    const reverseBtn = container.querySelector('button[aria-label="Reverse stops"]') as HTMLButtonElement;
    expect(reverseBtn).not.toBeNull();

    await act(async () => {
      reverseBtn.click();
    });

    expect(handleChange).toHaveBeenCalled();
    expect(currentValue).toContain("linear-gradient(");
  });
});
