// @vitest-environment jsdom
// The DOM must exist before react-dom loads: it decides at import time whether
// the `input` event is supported, and without it text inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TemplateRenderer, VariableForm, type PromptValues } from "../src";

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

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

/** Types into an input so React's onChange fires. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

describe("React TemplateRenderer with defaults, conditionals and values", () => {
  const prompt =
    "A {subject|red fox|Main subject}{?style} in the style of {style}{/style}{!style}, photo{/style}";

  it("renders defaults and conditional tags without values", async () => {
    await render(<TemplateRenderer content={prompt} />);
    const variable = container.querySelector('[data-variable="subject"]')!;
    expect(variable.textContent).toBe("{subject|red fox}");
    expect(variable.getAttribute("title")).toContain("Main subject");
    const tags = Array.from(container.querySelectorAll("[data-conditional]"));
    expect(tags.map((t) => t.textContent)).toEqual([
      "{?style}",
      "{/style}",
      "{!style}",
      "{/style}",
    ]);
  });

  it("renders values, defaults and only the sections that apply", async () => {
    await render(<TemplateRenderer content={prompt} values={{ style: "Monet" }} />);
    expect(container.textContent).toBe("A red fox in the style of Monet");
    expect(
      container.querySelector('[data-variable="subject"]')!.getAttribute("data-value-source"),
    ).toBe("default");
    expect(
      container.querySelector('[data-variable="style"]')!.getAttribute("data-value-source"),
    ).toBe("value");
    expect(container.querySelector("[data-conditional]")).toBeNull();

    await render(<TemplateRenderer content={prompt} values={{}} />);
    expect(container.textContent).toBe("A red fox, photo");
  });

  it("resolves templates before applying values", async () => {
    await render(
      <TemplateRenderer
        content="Shot of {{subject}}"
        templates={[{ name: "subject", body: "{animal|a cat}" }]}
        resolve
        values={{ animal: "an owl" }}
      />,
    );
    expect(container.textContent).toBe("Shot of an owl");
  });
});

describe("React VariableForm", () => {
  const prompt = "{subject|a red fox|Describe the subject} {mood} {?hd}4k{/hd}";

  it("renders an input per variable with label and placeholder", async () => {
    await render(<VariableForm content={prompt} />);
    const fields = Array.from(container.querySelectorAll("[data-variable-field]"));
    expect(fields.map((f) => f.getAttribute("data-variable-field"))).toEqual([
      "subject",
      "mood",
      "hd",
    ]);
    const subject = container.querySelector<HTMLInputElement>('input[name="subject"]')!;
    expect(subject.placeholder).toBe("a red fox");
    expect(fields[0].textContent).toContain("Describe the subject");
    expect(
      container.querySelector<HTMLInputElement>('input[name="mood"]')!.getAttribute("aria-required"),
    ).toBe("true");
    expect(
      container.querySelector<HTMLInputElement>('input[name="hd"]')!.type,
    ).toBe("checkbox");
  });

  it("emits a compact values map on change", async () => {
    const emitted: PromptValues[] = [];
    await render(<VariableForm content={prompt} onChange={(v) => emitted.push(v)} />);
    const mood = container.querySelector<HTMLInputElement>('input[name="mood"]')!;
    await type(mood, "calm");
    expect(emitted.at(-1)).toEqual({ mood: "calm" });
    expect(mood.value).toBe("calm");

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="hd"]')!.click();
    });
    expect(emitted.at(-1)).toEqual({ mood: "calm", hd: "true" });

    await type(mood, "");
    expect(emitted.at(-1)).toEqual({ hd: "true" });
  });

  it("supports controlled values and template variables", async () => {
    await render(
      <VariableForm
        content="{{t}}"
        templates={[{ name: "t", body: "{inner|x}" }]}
        values={{ inner: "set" }}
      />,
    );
    expect(
      container.querySelector<HTMLInputElement>('input[name="inner"]')!.value,
    ).toBe("set");
  });

  it("renders nothing for prompts without variables", async () => {
    await render(<VariableForm content="no variables" />);
    expect(container.innerHTML).toBe("");
  });
});
