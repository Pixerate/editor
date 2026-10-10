// @vitest-environment node
import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import { TemplateRenderer, EditableTextNodeEditor } from "../src";
import { SpreadsheetEditor } from "../src/spreadsheet";

describe("SSR", () => {
  it("renders components on the server without touching the DOM", () => {
    expect(typeof document).toBe("undefined");

    const { body } = render(TemplateRenderer, {
      props: {
        content: "A {{style}} shot of {subject}",
        templates: [{ name: "style", body: "cinematic" }],
      },
    });
    expect(body).toContain("subject");

    expect(() =>
      render(EditableTextNodeEditor, { props: { content: "<p>Hi</p>" } }),
    ).not.toThrow();
    expect(() => render(SpreadsheetEditor, { props: {} })).not.toThrow();
  });
});
