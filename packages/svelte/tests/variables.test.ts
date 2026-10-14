import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { TemplateRenderer, VariableForm } from "../src";
import type { PromptValues } from "../src";

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

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("Svelte TemplateRenderer with defaults, conditionals and values", () => {
  const prompt =
    "A {subject|red fox|Main subject}{?style} in the style of {style}{/style}{!style}, photo{/style}";

  it("renders defaults and conditional tags without values", () => {
    const target = setup(TemplateRenderer, { content: prompt });
    const variable = target.querySelector('[data-variable="subject"]')!;
    expect(variable.textContent).toBe("{subject|red fox}");
    expect(variable.getAttribute("title")).toContain("Main subject");
    const tags = Array.from(target.querySelectorAll("[data-conditional]"));
    expect(tags.map((t) => t.textContent)).toEqual([
      "{?style}",
      "{/style}",
      "{!style}",
      "{/style}",
    ]);
  });

  it("renders values, defaults and only the sections that apply", () => {
    const target = setup(TemplateRenderer, {
      content: prompt,
      values: { style: "Monet" },
    });
    expect(target.textContent).toBe("A red fox in the style of Monet");
    expect(
      target.querySelector('[data-variable="subject"]')!.getAttribute("data-value-source"),
    ).toBe("default");
    expect(
      target.querySelector('[data-variable="style"]')!.getAttribute("data-value-source"),
    ).toBe("value");
    expect(target.querySelector("[data-conditional]")).toBeNull();
  });

  it("hides {?name} sections when the value is empty", () => {
    const target = setup(TemplateRenderer, { content: prompt, values: {} });
    expect(target.textContent).toBe("A red fox, photo");
  });

  it("resolves templates before applying values", () => {
    const target = setup(TemplateRenderer, {
      content: "Shot of {{subject}}",
      templates: [{ name: "subject", body: "{animal|a cat}" }],
      resolve: true,
      values: { animal: "an owl" },
    });
    expect(target.textContent).toBe("Shot of an owl");
  });
});

describe("Svelte VariableForm", () => {
  const prompt = "{subject|a red fox|Describe the subject} {mood} {?hd}4k{/hd}";

  it("renders an input per variable with label and placeholder", () => {
    const target = setup(VariableForm, { content: prompt });
    const fields = Array.from(target.querySelectorAll("[data-variable-field]"));
    expect(fields.map((f) => f.getAttribute("data-variable-field"))).toEqual([
      "subject",
      "mood",
      "hd",
    ]);
    const subject = target.querySelector<HTMLInputElement>('input[name="subject"]')!;
    expect(subject.placeholder).toBe("a red fox");
    expect(fields[0].textContent).toContain("Describe the subject");
    expect(
      target.querySelector('input[name="mood"]')!.getAttribute("aria-required"),
    ).toBe("true");
    expect(target.querySelector<HTMLInputElement>('input[name="hd"]')!.type).toBe(
      "checkbox",
    );
  });

  it("emits a compact values map on change", () => {
    const emitted: PromptValues[] = [];
    const target = setup(VariableForm, {
      content: prompt,
      onChange: (values: PromptValues) => emitted.push(values),
    });
    const mood = target.querySelector<HTMLInputElement>('input[name="mood"]')!;
    type(mood, "calm");
    expect(emitted.at(-1)).toEqual({ mood: "calm" });

    target.querySelector<HTMLInputElement>('input[name="hd"]')!.click();
    flushSync();
    expect(emitted.at(-1)).toEqual({ mood: "calm", hd: "true" });

    type(mood, "");
    expect(emitted.at(-1)).toEqual({ hd: "true" });
  });

  it("shows initial values and template variables", () => {
    const target = setup(VariableForm, {
      content: "{{t}}",
      templates: [{ name: "t", body: "{inner|x}" }],
      values: { inner: "set" },
    });
    expect(target.querySelector<HTMLInputElement>('input[name="inner"]')!.value).toBe(
      "set",
    );
  });

  it("renders nothing for prompts without variables", () => {
    const target = setup(VariableForm, { content: "no variables" });
    expect(target.querySelector("form")).toBeNull();
  });
});
