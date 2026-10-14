// @vitest-environment node
import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import { TemplateRenderer, EditableTextNodeEditor, VariableForm, CommentsPanel, ReviewToolbar, OutlinePanel } from "../src";
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

    expect(
      render(VariableForm, { props: { content: "{subject|a fox|Who?}" } }).body,
    ).toContain('placeholder="a fox"');

    expect(() =>
      render(EditableTextNodeEditor, { props: { content: "<p>Hi</p>" } }),
    ).not.toThrow();
    expect(() => render(SpreadsheetEditor, { props: {} })).not.toThrow();
    expect(render(CommentsPanel, { props: {} }).body).toContain("No comments yet");
    expect(render(ReviewToolbar, { props: {} }).body).toContain("No changes");
    expect(render(OutlinePanel, { props: {} }).body).toContain("Document outline");
  });
});
