// @vitest-environment node
import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import { TemplateRenderer, EditableTextNodeEditor, VariableForm, CommentsPanel, ReviewToolbar, OutlinePanel } from "../src";
import { SpreadsheetEditor } from "../src/spreadsheet";
import { ParametersPanel } from "../src/parameters";
import { ParametersController } from "@pixerate/editor/parameters";
import { VectorEditor } from "../src/vector";
import { VectorEditorController, rectSubpath } from "@pixerate/editor/vector";
import { ChartEditor } from "../src/chart";
import { ChartController } from "@pixerate/editor/chart";
import { VideoEditor } from "../src/video-editor";
import { VideoEditorController } from "@pixerate/editor/video-editor";

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
    const controller = new ParametersController({
      schema: { title: "Glow", fields: [{ id: "speed", type: "number", min: 0, max: 4, default: 1 }] },
    });
    expect(render(ParametersPanel, { props: { controller, idPrefix: "p" } }).body).toContain('for="p-speed"');
    const vector = new VectorEditorController({
      document: { width: 100, height: 100, nodes: [{ id: "a", type: "path", fill: "#f00", subpaths: [rectSubpath({ x: 0, y: 0, width: 10, height: 10 })] }] },
    });
    expect(render(VectorEditor, { props: { controller: vector } }).body).toContain('data-vector-id="a"');
    const chart = new ChartController({ spec: { title: "Sales", categories: ["Q1"], series: [{ id: "n", name: "North", values: [3] }] } });
    const chartBody = render(ChartEditor, { props: { controller: chart } }).body;
    expect(chartBody).toContain('data-chart-key="bar-n-0"');
    expect(chartBody).toContain('data-cell="n:0"');
    const video = new VideoEditorController({
      project: { version: 1, width: 640, height: 360, fps: 30, assets: [], tracks: [{ id: "v1", kind: "video", clips: [{ id: "t", type: "text", text: "Hi", start: 0, duration: 1000 }] }] },
    });
    const videoBody = render(VideoEditor, { props: { controller: video } }).body;
    expect(videoBody).toContain('data-clip="t"');
    expect(videoBody).toContain("aspect-ratio:640 / 360");
  });
});
