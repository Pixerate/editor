// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DualColorPicker, useColorScheme, useResolvedColor } from "../src/color";

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
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
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

describe("React DualColorPicker and useColorScheme", () => {
  describe("useColorScheme", () => {
    it("returns override if provided", async () => {
      let scheme: string | undefined;
      function TestComp() {
        scheme = useColorScheme({ override: "dark" });
        return <div>{scheme}</div>;
      }

      await act(async () => {
        root.render(<TestComp />);
      });

      expect(scheme).toBe("dark");
    });

    it("tracks attribute override on documentElement", async () => {
      document.documentElement.setAttribute("data-theme", "dark");

      let scheme: string | undefined;
      function TestComp() {
        scheme = useColorScheme({ attribute: "data-theme" });
        return <div>{scheme}</div>;
      }

      await act(async () => {
        root.render(<TestComp />);
      });
      expect(scheme).toBe("dark");

      await act(async () => {
        document.documentElement.setAttribute("data-theme", "light");
      });
      expect(scheme).toBe("light");
    });

    it("resolves color according to active scheme", async () => {
      let color: string | null = null;
      function TestComp() {
        color = useResolvedColor("light-dark(#ffffff, #000000)", "dark");
        return <div>{color}</div>;
      }

      await act(async () => {
        root.render(<TestComp />);
      });
      expect(color).toBe("#000000");
    });
  });

  describe("DualColorPicker Component", () => {
    it("renders both Light and Dark previews for a light-dark() value", async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <DualColorPicker
            value="light-dark(#ffffff, #000000)"
            onChange={onChange}
          />,
        );
      });

      expect(container.textContent).toContain("Light");
      expect(container.textContent).toContain("Dark");
      expect(container.textContent).toContain("Same in both");
    });

    it("switches to Dark scheme and editing updates only dark half", async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <DualColorPicker
            value={{ light: "#ffffff", dark: "#000000" }}
            onChange={onChange}
          />,
        );
      });

      // Click Dark tab button
      const buttons = container.querySelectorAll("button");
      const darkBtn = Array.from(buttons).find((b) => b.textContent?.trim() === "Dark");
      expect(darkBtn).toBeDefined();

      await act(async () => {
        darkBtn!.click();
      });

      // Find the hex input
      const hexInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(hexInput).not.toBeNull();
      expect(hexInput.value.toLowerCase()).toBe("#000000");

      await act(async () => {
        setInputValue(hexInput, "#123456");
        hexInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });

      expect(onChange).toHaveBeenCalledWith({
        light: "#ffffff",
        dark: "#123456",
      });
    });

    it('keeps halves equal when "Same in both" is enabled', async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <DualColorPicker
            value={{ light: "#111111", dark: "#222222" }}
            onChange={onChange}
          />,
        );
      });

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).toBeDefined();

      await act(async () => {
        checkbox.click();
      });

      // Toggling on copies active half (light) to both
      expect(onChange).toHaveBeenCalledWith({
        light: "#111111",
        dark: "#111111",
      });

      // Now edit hex input
      const hexInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(hexInput).not.toBeNull();
      await act(async () => {
        setInputValue(hexInput, "#333333");
        hexInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });

      expect(onChange).toHaveBeenCalledWith({
        light: "#333333",
        dark: "#333333",
      });
    });

    it("derives opposing half with Derive button", async () => {
      const onChange = vi.fn();
      const onGestureStart = vi.fn();
      const onGestureEnd = vi.fn();

      await act(async () => {
        root.render(
          <DualColorPicker
            value={{ light: "#1d4ed8", dark: "#1d4ed8" }}
            onChange={onChange}
            onGestureStart={onGestureStart}
            onGestureEnd={onGestureEnd}
          />,
        );
      });

      const buttons = container.querySelectorAll("button");
      const deriveBtn = Array.from(buttons).find((b) => b.textContent?.trim() === "Derive");
      expect(deriveBtn).toBeDefined();

      await act(async () => {
        deriveBtn!.click();
      });

      expect(onGestureStart).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalled();
      expect(onGestureEnd).toHaveBeenCalled();

      const callArg = onChange.mock.calls[0][0];
      expect(callArg.light).toBe("#1d4ed8");
      expect(callArg.dark).not.toBe("#1d4ed8");
    });

    it("displays contrast ratio for both schemes when contrastAgainst is provided", async () => {
      await act(async () => {
        root.render(
          <DualColorPicker
            value={{ light: "#ffffff", dark: "#ffffff" }}
            contrastAgainst={{ light: "#000000", dark: "#000000" }}
            onChange={vi.fn()}
          />,
        );
      });

      const summary = container.querySelector('[data-testid="dual-contrast-summary"]');
      expect(summary).toBeDefined();
      expect(summary!.textContent).toContain("Light:");
      expect(summary!.textContent).toContain("Dark:");
      expect(summary!.textContent).toContain("21.00");
    });
  });
});
