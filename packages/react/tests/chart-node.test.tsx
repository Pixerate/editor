// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act } from "react";
import { Editor } from "@tiptap/core";
import { createRichTextPreset, getDocumentCharts } from "@pixerate/editor";
import { createChartSpec } from "@pixerate/editor/chart";
import { createReactChartNodeView } from "../src";

const SPEC = createChartSpec({
  title: "Quarterly sales",
  categories: ["Q1", "Q2", "Q3"],
  series: [{ id: "north", name: "North", values: [12, 18, 9] }],
});

let editor: Editor | null = null;
let element: HTMLDivElement;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => editor?.destroy());
  editor = null;
  element?.remove();
});

async function mount(content: any = { type: "doc", content: [{ type: "paragraph" }, { type: "chart", attrs: { id: "c1", spec: SPEC, height: 260 } }] }) {
  element = document.createElement("div");
  document.body.appendChild(element);
  await act(async () => {
    editor = new Editor({ element, extensions: createRichTextPreset({ chart: { nodeView: createReactChartNodeView() } }), content });
  });
  return editor!;
}

const q = (sel: string) => element.querySelector(sel) as HTMLElement | null;
const spec = () => getDocumentCharts(editor!.state.doc)[0].spec;

describe("React chart node view", () => {
  it("draws the chart read-only until clicked", async () => {
    await mount();
    expect(q("[data-chart-node-view]")).not.toBeNull();
    expect(q("[data-chart-node-view] svg")?.getAttribute("aria-label")).toContain("Quarterly sales");
    expect(q("[data-chart-inspector], [data-chart-node-toolbar]")).toBeNull();
    expect(q("[data-chart-node-view] svg")?.getAttribute("height")).toBe("260");
  });

  it("opens the inspector on click and writes edits back to the document", async () => {
    await mount();
    await act(async () => q("[data-chart-node-canvas]")!.click());
    expect(q("[data-chart-node-view]")!.hasAttribute("data-editing")).toBe(true);
    expect(q("[data-chart-node-toolbar]")).not.toBeNull();
    expect(element.querySelectorAll("[data-chart-node-view] input, [data-chart-node-view] select").length).toBeGreaterThan(0);

    // An inspector edit (the chart type) lands in the document as an undo step.
    await act(async () => q('[data-chart-node-view] [data-chart-type="line"]')!.click());
    expect(spec().type).toBe("line");
    await act(async () => void editor!.commands.undo());
    expect(spec().type).toBe("bar");

    await act(async () => (q('[data-action="done"]') as HTMLButtonElement).click());
    expect(q("[data-chart-node-toolbar]")).toBeNull();
  });

  it("shows agent and undo changes, and never opens in a read-only editor", async () => {
    await mount();
    await act(async () => void editor!.commands.updateChart("c1", { spec: { ...SPEC, title: "Revised" } }));
    expect(q("[data-chart-node-view] svg")?.getAttribute("aria-label")).toContain("Revised");
    await act(async () => editor!.setEditable(false));
    await act(async () => q("[data-chart-node-canvas]")!.click());
    expect(q("[data-chart-node-toolbar]")).toBeNull();
  });
});
