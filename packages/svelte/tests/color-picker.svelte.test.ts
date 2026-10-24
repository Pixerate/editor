import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ColorPicker } from "../src/color";

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

describe("Svelte ColorPicker", () => {
  it("renders with initial colour and sliders", () => {
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      onchange: () => {},
    });

    const sliders = target.querySelectorAll('[role="slider"]');
    expect(sliders.length).toBe(2); // Area + Hue slider

    const area = target.querySelector('[aria-label="Saturation and brightness"]');
    expect(area).not.toBeNull();

    const hue = target.querySelector('[aria-label="Hue"]');
    expect(hue).not.toBeNull();

    const input = target.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value.toLowerCase()).toBe("#ff0000");
  });

  it("handles keyboard navigation on the 2D area", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#808080",
      onchange: handleChange,
    });

    const area = target.querySelector('[aria-label="Saturation and brightness"]') as HTMLElement;
    expect(area).not.toBeNull();

    area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();

    expect(handleChange).toHaveBeenCalled();
  });

  it("handles keyboard navigation on the hue slider", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      onchange: handleChange,
    });

    const hue = target.querySelector('[aria-label="Hue"]') as HTMLElement;
    expect(hue).not.toBeNull();

    hue.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();

    expect(handleChange).toHaveBeenCalled();
  });

  it("renders alpha slider when alpha is true and updates alpha via keyboard", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#ff0000ff",
      alpha: true,
      onchange: handleChange,
    });

    const sliders = target.querySelectorAll('[role="slider"]');
    expect(sliders.length).toBe(3); // Area, Hue, Alpha

    const alphaSlider = target.querySelector('[aria-label="Alpha"]') as HTMLElement;
    expect(alphaSlider).not.toBeNull();

    alphaSlider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    flushSync();

    expect(handleChange).toHaveBeenCalled();
    const emitted = handleChange.mock.calls[0][0];
    expect(emitted.length).toBe(9); // 8-digit hex + #
  });

  it("commits valid colour from text input on Enter", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      onchange: handleChange,
    });

    const input = target.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "#00ff00";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();

    expect(handleChange).toHaveBeenCalledWith("#00ff00");
  });

  it("reverts invalid colour from text input on blur", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      onchange: handleChange,
    });

    const input = target.querySelector('input[type="text"]') as HTMLInputElement;
    input.focus();
    input.value = "not-a-valid-colour";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    flushSync();

    expect(handleChange).not.toHaveBeenCalled();
    expect(input.value.toLowerCase()).toBe("#ff0000");
  });

  it("clicks palette swatches and triggers onChange", () => {
    const handleChange = vi.fn();
    const swatches = ["#ff0000", "#00ff00", "#0000ff"];
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      swatches,
      onchange: handleChange,
    });

    const swatchButtons = target.querySelectorAll('button[data-testid="color-picker-swatch"]');
    expect(swatchButtons.length).toBe(3);

    (swatchButtons[1] as HTMLButtonElement).click();
    flushSync();

    expect(handleChange).toHaveBeenCalledWith("#00ff00");
  });

  it("displays contrast ratio badge when contrastAgainst is provided", () => {
    const { target } = render(ColorPicker, {
      value: "#000000",
      contrastAgainst: "#ffffff",
      onchange: () => {},
    });

    expect(target.textContent).toContain("21.00:1");
    expect(target.textContent).toContain("AA ✓");
    expect(target.textContent).toContain("AAA ✓");
  });

  it("respects disabled prop", () => {
    const handleChange = vi.fn();
    const { target } = render(ColorPicker, {
      value: "#ff0000",
      disabled: true,
      onchange: handleChange,
    });

    const area = target.querySelector('[aria-label="Saturation and brightness"]') as HTMLElement;
    expect(area.getAttribute("aria-disabled")).toBe("true");

    area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();

    expect(handleChange).not.toHaveBeenCalled();

    const input = target.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
