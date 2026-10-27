// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { FontPicker, TypographyControl, useFontPicker, FontPickerModel, createFontPickerToolProvider, type FontSpec, type FontSummary, type FontProvider } from "../src/typography";
import { ToolRegistry } from "@pixerate/editor/tools";
import { EffectParameters } from "../src/effects";

const TITLE_EFFECT: any = {
  id: "demo.title",
  name: "Title",
  use: "title",
  controls: { type: "object", properties: { font: { type: "string", format: "font", title: "Font", default: "Lora" }, text: { type: "string", default: "Hi" } } },
  defaults: { font: "Lora", text: "Hi" },
  presets: [],
  inputs: [],
};

const FONTS: FontSummary[] = [
  { family: "Inter", category: "sans-serif", weights: [200, 800], styles: ["normal", "italic"], isVariable: true, source: "web" },
  { family: "Lora", category: "serif", weights: [400, 700], styles: ["normal"], source: "custom" },
  { family: "Menlo", category: "monospace", weights: [400, 700], styles: ["normal", "italic"], source: "system" },
];

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

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function select(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;
const options = () => [...container.querySelectorAll('[role="option"]')].map((o) => o.querySelector("span")!.textContent);

describe("React FontPicker", () => {
  it("lists fonts in their own face and marks the selection", async () => {
    await act(async () => root.render(<FontPicker fonts={FONTS} value={{ family: "Lora" }} />));
    expect(options()).toEqual(["Inter", "Lora", "Menlo"]);
    const selected = q<HTMLElement>('[role="option"][aria-selected="true"]');
    expect(selected.textContent).toContain("Lora");
    expect((selected.querySelector("span") as HTMLElement).style.fontFamily).toMatch(/^Lora, Charter/);
    expect(q('[aria-label="Font preview"]').textContent).toContain("quick brown fox");
  });

  it("filters by search and category, and selects with the keyboard", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<FontPicker fonts={FONTS} value={{ family: "Inter" }} onChange={onChange} />));
    const search = q<HTMLInputElement>('[role="combobox"]');
    await act(async () => type(search, "m"));
    expect(options()).toEqual(["Menlo"]);
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(search.getAttribute("aria-activedescendant")).toBeTruthy();
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Menlo", category: "monospace" }));

    await act(async () => type(search, ""));
    await act(async () => select(q<HTMLSelectElement>('[aria-label="Font category"]'), "serif"));
    expect(options()).toEqual(["Lora"]);
  });

  it("clicks select a family and weights snap to what it has", async () => {
    function Host() {
      const [value, setValue] = useState<Partial<FontSpec>>({ family: "Inter", weight: 600 });
      return (
        <>
          <FontPicker fonts={FONTS} value={value} onChange={setValue} />
          <output>{JSON.stringify(value)}</output>
        </>
      );
    }
    await act(async () => root.render(<Host />));
    const weight = q<HTMLSelectElement>('[aria-label="Font weight"]');
    expect([...weight.options].map((o) => o.value)).toEqual(["200", "300", "400", "500", "600", "700", "800"]);
    await act(async () => (container.querySelectorAll('[role="option"]')[1] as HTMLElement).click());
    expect(JSON.parse(q("output").textContent!)).toMatchObject({ family: "Lora", weight: 700 });
    expect([...q<HTMLSelectElement>('[aria-label="Font weight"]').options].map((o) => o.value)).toEqual(["400", "700"]);
    await act(async () => select(q<HTMLSelectElement>('[aria-label="Font weight"]'), "400"));
    expect(JSON.parse(q("output").textContent!).weight).toBe(400);
  });

  it("fetches from a provider and shows load failures", async () => {
    const provider: FontProvider = { id: "p", listFonts: async () => FONTS, hasFont: () => true, loadFont: async () => false };
    await act(async () => root.render(<FontPicker provider={provider} value={{ family: "Lora" }} />));
    await act(async () => {});
    expect(options()).toEqual(["Inter", "Lora", "Menlo"]);
    await act(async () => (container.querySelectorAll('[role="option"]')[0] as HTMLElement).click());
    await act(async () => {});
    expect(q('[role="status"]').textContent).toMatch(/Inter could not be loaded/);
  });

  it("follows agent edits made through the font picker tools", async () => {
    const model = new FontPickerModel({ fonts: FONTS, loadOnSelect: false });
    const onChange = vi.fn();
    const registry = new ToolRegistry();
    registry.register(createFontPickerToolProvider(model));
    await act(async () => root.render(<FontPicker model={model} onChange={onChange} />));
    await act(async () => {
      const res = await registry.callTool("set_font_selection", { family: "Menlo", weight: 700 });
      expect(res.isError).toBeFalsy();
    });
    expect(q('[role="option"][aria-selected="true"]').textContent).toContain("Menlo");
    expect(q<HTMLSelectElement>('[aria-label="Font weight"]').value).toBe("700");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Menlo", weight: 700 }));
  });
});

describe("React TypographyControl", () => {
  it("edits size, line height and letter spacing", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<TypographyControl fonts={FONTS} value={{ family: "Inter", size: 16 }} onChange={onChange} />));
    expect(q('[role="group"]').getAttribute("aria-label")).toBe("Typography");
    await act(async () => type(q<HTMLInputElement>('input[aria-label="Font size"]'), "20"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ size: 20 }));
    await act(async () => type(q<HTMLInputElement>('input[aria-label="Line height"]'), "1.6"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lineHeight: 1.6 }));
    await act(async () => type(q<HTMLInputElement>('input[aria-label="Letter spacing"]'), "0.02"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ letterSpacing: 0.02 }));
    expect(q<HTMLElement>('[aria-label="Font preview"]').style.lineHeight).toBe("1.6");
  });

  it("does not echo controlled value updates back through onChange", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<TypographyControl fonts={FONTS} value={{ family: "Inter", size: 16 }} onChange={onChange} />));
    await act(async () => root.render(<TypographyControl fonts={FONTS} value={{ family: "Lora", size: 18 }} onChange={onChange} />));
    expect(q<HTMLInputElement>('input[aria-label="Font size"]').value).toBe("18");
    expect(q('[role="option"][aria-selected="true"]').textContent).toContain("Lora");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useFontPicker", () => {
  it("returns a stable model and live state", async () => {
    const seen: FontPickerModel[] = [];
    let latest: any;
    function Probe() {
      const picker = useFontPicker({ fonts: FONTS });
      seen.push(picker.model);
      latest = picker.state;
      return null;
    }
    await act(async () => root.render(<Probe />));
    await act(async () => seen[0]!.setQuery("lor"));
    expect(latest.results.map((f: FontSummary) => f.family)).toEqual(["Lora"]);
    expect(new Set(seen).size).toBe(1);
  });
});

describe("EffectParameters font controls", () => {
  it("shows a font control as a choice of the host's fonts", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<EffectParameters description={TITLE_EFFECT} values={{}} fonts={FONTS} onChange={onChange} />));
    const sel = q<HTMLSelectElement>('[data-effect-control="font"] select');
    // Choice options are indexed; the labels are the families.
    expect([...sel.options].map((o) => o.textContent!.trim())).toEqual(["Inter", "Lora", "Menlo"]);
    expect(sel.selectedOptions[0]!.textContent!.trim()).toBe("Lora");
    await act(async () => select(sel, "2"));
    expect(onChange).toHaveBeenCalledWith("font", "Menlo", null);
  });
});
