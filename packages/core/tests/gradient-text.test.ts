// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { GradientText } from "../src/extensions";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function render(html: string): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit, GradientText],
    content: html,
  });
  return editor.view.dom as HTMLElement;
}

describe("GradientText variable and conditional decorations", () => {
  it("decorates plain variables as before", () => {
    const dom = render("<p>A {subject} here</p>");
    const el = dom.querySelector('[data-variable="subject"]')!;
    expect(el.textContent).toBe("{subject}");
    expect(el.hasAttribute("data-default")).toBe(false);
    expect(el.className).not.toContain("border-dashed");
  });

  it("marks variables with defaults and descriptions distinctly", () => {
    const dom = render("<p>{subject|a red fox|Describe the subject}</p>");
    const el = dom.querySelector('[data-variable="subject"]')!;
    expect(el.getAttribute("data-default")).toBe("a red fox");
    expect(el.getAttribute("data-description")).toBe("Describe the subject");
    expect(el.getAttribute("title")).toBe(
      "Describe the subject · Default: a red fox",
    );
    expect(el.className).toContain("border-dashed");
  });

  it("decorates balanced conditional tags, even across paragraphs", () => {
    const dom = render("<p>{?style}in the style of {style}</p><p>{/style}</p>");
    const tags = Array.from(dom.querySelectorAll("[data-conditional]"));
    expect(tags.map((t) => [t.textContent, t.getAttribute("data-conditional")])).toEqual([
      ["{?style}", "if"],
      ["{/style}", "end"],
    ]);
    // The tags are not decorated as variables.
    expect(dom.querySelectorAll("[data-variable]")).toHaveLength(1);
    expect(dom.querySelector("[data-conditional-error]")).toBeNull();
  });

  it("flags unbalanced conditional tags", () => {
    const dom = render("<p>{!night} day {/x}</p>");
    const errors = Array.from(dom.querySelectorAll("[data-conditional-error]"));
    expect(errors.map((e) => [e.textContent, e.getAttribute("data-conditional-error")])).toEqual([
      ["{!night}", "unclosed-section"],
      ["{/x}", "unexpected-close"],
    ]);
  });

  it("decorates comparison conditions and flags malformed ones", () => {
    const dom = render("<p>{?amount>100}big{/amount} {?n=}x{/n}</p>");
    const tags = Array.from(dom.querySelectorAll("[data-conditional]"));
    expect(
      tags.map((t) => [t.textContent, t.getAttribute("data-variable-condition")]),
    ).toEqual([
      ["{?amount>100}", "amount"],
      ["{/amount}", "amount"],
    ]);
    const errors = Array.from(dom.querySelectorAll("[data-conditional-error]"));
    expect(errors.map((e) => [e.textContent, e.getAttribute("data-conditional-error")])).toEqual([
      ["{?n=}", "invalid-condition"],
      ["{/n}", "invalid-condition"],
    ]);
    expect(errors[0].getAttribute("title")).toContain("Missing value");
  });
});
