import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { MergePreview, TemplateRenderer, createMergePreview } from "../src";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(component: any, props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanup = () => {
    unmount(instance);
    target.remove();
  };
  return target;
}

function setValue(
  element: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event: "input" | "change",
) {
  element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
  flushSync();
}

function click(target: HTMLElement, selector: string) {
  (target.querySelector(selector) as HTMLButtonElement).click();
  flushSync();
}

const csv = "First Name,City,Amount\nAda,London,250\nAlan,Wilmslow,40\n,Arlington,";
const template = "Dear {firstName|friend} of {place}{?amount>100}, VIP{/amount}.";

describe("Svelte MergePreview", () => {
  it("previews records, steps through them and maps fields", () => {
    const target = setup(MergePreview, { content: template, defaultSource: csv });
    const text = (selector: string) => target.querySelector(selector)!.textContent;
    expect(text("[data-merge-summary]")).toBe("3 records · 3 fields");
    expect(text("[data-merge-position]")).toBe("Record 1 of 3");
    expect(text("[data-merge-output]")).toBe("Dear Ada of {place}, VIP.");
    const placeSelect = target.querySelector(
      '[data-merge-mapping="place"] select',
    ) as HTMLSelectElement;
    expect(placeSelect.value).toBe("");
    expect(
      (target.querySelector('[data-merge-mapping="firstName"] select') as HTMLSelectElement).value,
    ).toBe("First Name");

    setValue(placeSelect, "City", "change");
    expect(text("[data-merge-output]")).toBe("Dear Ada of London, VIP.");

    click(target, "[data-merge-next]");
    expect(text("[data-merge-position]")).toBe("Record 2 of 3");
    expect(text("[data-merge-output]")).toBe("Dear Alan of Wilmslow.");
    click(target, "[data-merge-next]");
    expect(text("[data-merge-output]")).toBe("Dear friend of Arlington.");
    expect((target.querySelector("[data-merge-next]") as HTMLButtonElement).disabled).toBe(true);
    click(target, "[data-merge-prev]");
    expect(text("[data-merge-position]")).toBe("Record 2 of 3");
  });

  it("merges all records with skipIf and exposes text output", () => {
    const onMerge = vi.fn();
    const target = setup(MergePreview, {
      content: "{City}",
      defaultSource: csv,
      skipIf: "Amount<100",
      separator: "\n",
      onMerge,
    });
    click(target, "[data-merge-all]");
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(onMerge.mock.calls[0][0].outputs.map((o: any) => o.text)).toEqual(["London"]);
    expect(target.querySelector("[data-merge-result]")!.textContent).toBe("1 merged, 2 skipped");
    expect((target.querySelector("[data-merge-text]") as HTMLTextAreaElement).value).toBe("London");
  });

  it("re-parses pasted data and resets to the first record", () => {
    const target = setup(MergePreview, { content: "{name}", defaultSource: "name\nA\nB" });
    const text = (selector: string) => target.querySelector(selector)!.textContent;
    click(target, "[data-merge-next]");
    expect(text("[data-merge-output]")).toBe("B");
    const source = target.querySelector("[data-merge-source]") as HTMLTextAreaElement;
    setValue(source, '[{"name":"Json"}]', "input");
    expect(text("[data-merge-position]")).toBe("Record 1 of 1");
    expect(text("[data-merge-output]")).toBe("Json");
    setValue(source, "", "input");
    expect(text("[data-merge-position]")).toBe("No records");
    expect((target.querySelector("[data-merge-all]") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Svelte createMergePreview", () => {
  it("exposes reactive headless state", async () => {
    let template = $state("{first} {n}");
    const state = createMergePreview(() => ({ template }), "GivenName,n\nAda,1\nBo,2");
    expect(state.variables).toEqual(["first", "n"]);
    expect(state.mapping).toEqual({ first: "GivenName", n: "n" });
    expect(state.values).toMatchObject({ first: "Ada", n: "1" });
    state.setIndex(5);
    expect(state.index).toBe(1);
    state.setFieldMapping("first", null);
    expect(state.values.first).toBeUndefined();
    state.merge();
    expect(state.serialize("text")).toBe("{first} 1\n\n{first} 2");
    expect(JSON.parse(state.serialize("json"))[1]).toEqual({ record: 2, text: "{first} 2" });
    template = "{n}!";
    expect(state.variables).toEqual(["n"]);
    await state.loadFile(new Blob(["n\n9"]));
    expect(state.count).toBe(1);
    expect(state.result).toBeNull();
  });
});

describe("Svelte TemplateRenderer comparison tags", () => {
  it("shows comparison tags and evaluates them with values", () => {
    let target = setup(TemplateRenderer, { content: "{?n>3}many{/n}" });
    const tags = Array.from(target.querySelectorAll("[data-conditional]"));
    expect(tags.map((t) => t.textContent)).toEqual(["{?n>3}", "{/n}"]);
    expect(tags[0].getAttribute("title")).toBe('Shown when "n" > 3');
    cleanup?.();
    target = setup(TemplateRenderer, { content: "{?n>3}many{/n}", values: { n: 2 } });
    expect(target.textContent!.trim()).toBe("");
  });
});
