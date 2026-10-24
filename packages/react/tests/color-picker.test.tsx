// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ColorPicker } from "../src/color";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("React ColorPicker", () => {
  it("renders with initial colour and sliders", async () => {
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          onChange={() => {}}
        />,
      );
    });

    const sliders = container.querySelectorAll('[role="slider"]');
    expect(sliders.length).toBe(2); // Area + Hue slider

    const area = container.querySelector('[aria-label="Saturation and brightness"]');
    expect(area).not.toBeNull();

    const hue = container.querySelector('[aria-label="Hue"]');
    expect(hue).not.toBeNull();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value.toLowerCase()).toBe("#ff0000");
  });

  it("handles keyboard navigation on the 2D area", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#808080"
          onChange={handleChange}
        />,
      );
    });

    const area = container.querySelector('[aria-label="Saturation and brightness"]') as HTMLElement;
    expect(area).not.toBeNull();

    // Press ArrowRight to increase saturation
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(handleChange).toHaveBeenCalled();
  });

  it("handles keyboard navigation on the hue slider", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          onChange={handleChange}
        />,
      );
    });

    const hue = container.querySelector('[aria-label="Hue"]') as HTMLElement;
    expect(hue).not.toBeNull();

    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(handleChange).toHaveBeenCalled();
  });

  it("renders alpha slider when alpha is true and updates alpha via keyboard", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000ff"
          alpha={true}
          onChange={handleChange}
        />,
      );
    });

    const sliders = container.querySelectorAll('[role="slider"]');
    expect(sliders.length).toBe(3); // Area, Hue, Alpha

    const alphaSlider = container.querySelector('[aria-label="Alpha"]') as HTMLElement;
    expect(alphaSlider).not.toBeNull();

    await act(async () => {
      alphaSlider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    expect(handleChange).toHaveBeenCalled();
    const emitted = handleChange.mock.calls[0][0];
    expect(emitted.length).toBe(9); // 8-digit hex + #
  });

  it("commits valid colour from text input on Enter", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          onChange={handleChange}
        />,
      );
    });

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "#00ff00");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(handleChange).toHaveBeenCalledWith("#00ff00");
  });

  it("reverts invalid colour from text input on blur", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          onChange={handleChange}
        />,
      );
    });

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    await act(async () => {
      input.focus();
      setInputValue(input, "not-a-valid-colour");
      input.blur();
    });

    expect(handleChange).not.toHaveBeenCalled();
    expect(input.value.toLowerCase()).toBe("#ff0000");
  });

  it("clicks palette swatches and triggers onChange", async () => {
    const handleChange = vi.fn();
    const swatches = ["#ff0000", "#00ff00", "#0000ff"];
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          swatches={swatches}
          onChange={handleChange}
        />,
      );
    });

    const swatchButtons = container.querySelectorAll('button[data-testid="color-picker-swatch"]');
    expect(swatchButtons.length).toBe(3);

    await act(async () => {
      (swatchButtons[1] as HTMLButtonElement).click();
    });

    expect(handleChange).toHaveBeenCalledWith("#00ff00");
  });

  it("displays contrast ratio badge when contrastAgainst is provided", async () => {
    await act(async () => {
      root.render(
        <ColorPicker
          value="#000000"
          contrastAgainst="#ffffff"
          onChange={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("21.00:1");
    expect(container.textContent).toContain("AA ✓");
    expect(container.textContent).toContain("AAA ✓");
  });

  it("respects disabled prop", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      root.render(
        <ColorPicker
          value="#ff0000"
          disabled={true}
          onChange={handleChange}
        />,
      );
    });

    const area = container.querySelector('[aria-label="Saturation and brightness"]') as HTMLElement;
    expect(area.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(handleChange).not.toHaveBeenCalled();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});

describe("React ColorPicker drags", () => {
  it("ends the host's gesture and stops listening when unmounted mid-drag", async () => {
    const onChange = vi.fn();
    const onGestureStart = vi.fn();
    const onGestureEnd = vi.fn();
    await act(async () =>
      root.render(<ColorPicker value="#ff0000" onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />)
    );
    const hue = container.querySelector('[aria-label="Hue"]') as HTMLElement;
    await act(async () => {
      hue.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }));
    });
    expect(onGestureStart).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<div />));
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
    const calls = onChange.mock.calls.length;
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
  });
});
