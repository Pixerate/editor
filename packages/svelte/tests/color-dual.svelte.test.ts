import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import {
  DualColorPicker,
  createColorScheme,
  resolvedColor
} from "../src/color";

let cleanups: (() => void)[] = [];

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  document.documentElement.removeAttribute("data-theme");
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

describe("Svelte DualColorPicker and createColorScheme", () => {
  describe("createColorScheme", () => {
    it("returns override if provided", () => {
      const scheme = createColorScheme({ override: "dark" });
      cleanups.push(() => scheme.destroy());
      expect(scheme.current).toBe("dark");
    });

    it("tracks attribute override on documentElement", async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      const scheme = createColorScheme({ attribute: "data-theme" });
      cleanups.push(() => scheme.destroy());

      expect(scheme.current).toBe("dark");

      document.documentElement.setAttribute("data-theme", "light");
      // Wait for MutationObserver to fire
      await new Promise((r) => setTimeout(r, 10));
      expect(scheme.current).toBe("light");
    });

    it("resolves color according to active scheme", () => {
      const dual = "light-dark(#ffffff, #000000)";
      expect(resolvedColor(dual, "light")?.toLowerCase()).toBe("#ffffff");
      expect(resolvedColor(dual, "dark")?.toLowerCase()).toBe("#000000");
    });
  });

  describe("DualColorPicker Component", () => {
    it("renders both Light and Dark previews for a light-dark() value", () => {
      const { target } = render(DualColorPicker, {
        value: "light-dark(#ffffff, #000000)",
        onchange: () => {}
      });

      const tabs = target.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(2);
      expect(tabs[0].textContent?.trim()).toBe("Light");
      expect(tabs[1].textContent?.trim()).toBe("Dark");

      // Verify initial active tab is Light
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");

      // Verify text input has light color
      const hexInput = target.querySelector('input[type="text"]') as HTMLInputElement;
      expect(hexInput).not.toBeNull();
      expect(hexInput.value.toLowerCase()).toBe("#ffffff");
    });

    it("switches to Dark scheme and editing updates only dark half", () => {
      const onchange = vi.fn();
      const { target } = render(DualColorPicker, {
        value: { light: "#ffffff", dark: "#000000" },
        onchange
      });

      // Click Dark tab button
      const tabs = target.querySelectorAll('[role="tab"]');
      const darkBtn = Array.from(tabs).find((b) => b.textContent?.trim() === "Dark") as HTMLElement;
      expect(darkBtn).not.toBeNull();

      darkBtn.click();
      flushSync();

      // Find the hex input
      const hexInput = target.querySelector('input[type="text"]') as HTMLInputElement;
      expect(hexInput).not.toBeNull();
      expect(hexInput.value.toLowerCase()).toBe("#000000");

      hexInput.value = "#123456";
      hexInput.dispatchEvent(new Event("input", { bubbles: true }));
      hexInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flushSync();

      expect(onchange).toHaveBeenCalledWith({
        light: "#ffffff",
        dark: "#123456"
      });
    });

    it('keeps halves equal when "Same in both" is enabled', () => {
      const onchange = vi.fn();
      const { target } = render(DualColorPicker, {
        value: { light: "#111111", dark: "#222222" },
        onchange
      });

      const checkbox = target.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).not.toBeNull();

      checkbox.click();
      flushSync();

      // Toggling on copies active half (light) to both
      expect(onchange).toHaveBeenCalledWith({
        light: "#111111",
        dark: "#111111"
      });

      // Now edit hex input
      const hexInput = target.querySelector('input[type="text"]') as HTMLInputElement;
      expect(hexInput).not.toBeNull();

      hexInput.value = "#333333";
      hexInput.dispatchEvent(new Event("input", { bubbles: true }));
      hexInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flushSync();

      expect(onchange).toHaveBeenCalledWith({
        light: "#333333",
        dark: "#333333"
      });
    });

    it("derives opposing half with Derive button", () => {
      const onchange = vi.fn();
      const { target } = render(DualColorPicker, {
        value: { light: "#1e40af", dark: "#000000" },
        onchange
      });

      const deriveBtn = Array.from(target.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Derive")
      );
      expect(deriveBtn).not.toBeUndefined();

      deriveBtn!.click();
      flushSync();

      expect(onchange).toHaveBeenCalled();
      const result = onchange.mock.calls[0][0];
      expect(result.light).toBe("#1e40af");
      expect(result.dark).toBeDefined();
      expect(result.dark).not.toBe("#000000");
    });

    it("displays contrast ratio for both schemes when contrastAgainst is provided", () => {
      const { target } = render(DualColorPicker, {
        value: { light: "#000000", dark: "#ffffff" },
        contrastAgainst: { light: "#ffffff", dark: "#000000" }
      });

      const text = target.textContent ?? "";
      expect(text).toContain("Light:");
      expect(text).toContain("Dark:");
      expect(text).toContain("21:1");
    });
  });
});
