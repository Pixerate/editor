import { describe, it, expect, afterEach } from "vitest";
import { flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { createRichTextPreset, getDocumentCharts } from "@pixerate/editor";
import { createChartSpec } from "@pixerate/editor/chart";
import { createSvelteChartNodeView } from "../src";

const SPEC = createChartSpec({
  title: "Quarterly sales",
  categories: ["Q1", "Q2", "Q3"],
  series: [{ id: "north", name: "North", values: [12, 18, 9] }],
});

let editor: Editor | null = null;
let element: HTMLDivElement;

afterEach(() => {
  editor?.destroy();
  editor = null;
  element?.remove();
});

function mount(content: any = { type: "doc", content: [{ type: "paragraph" }, { type: "chart", attrs: { id: "c1", spec: SPEC, height: 260 } }] }) {
  element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: createRichTextPreset({ chart: { nodeView: createSvelteChartNodeView() } }), content });
  flushSync();
  return editor;
}

const q = (sel: string) => element.querySelector(sel) as HTMLElement | null;
const spec = () => getDocumentCharts(editor!.state.doc)[0].spec;
const click = (el: HTMLElement) => {
  el.click();
  flushSync();
};

describe("Svelte chart node view", () => {
  it("draws the chart read-only until clicked", () => {
    mount();
    expect(q("[data-chart-node-view]")).not.toBeNull();
    expect(q("[data-chart-node-view] svg")?.getAttribute("aria-label")).toContain("Quarterly sales");
    expect(q("[data-chart-node-toolbar]")).toBeNull();
    expect(q("[data-chart-node-view] svg")?.getAttribute("height")).toBe("260");
  });

  it("opens the inspector on click and writes edits back to the document", () => {
    mount();
    click(q("[data-chart-node-canvas]")!);
    expect(q("[data-chart-node-view]")!.hasAttribute("data-editing")).toBe(true);
    expect(q("[data-chart-node-toolbar]")).not.toBeNull();
    click(q('[data-chart-node-view] [data-chart-type="line"]')!);
    expect(spec().type).toBe("line");
    editor!.commands.undo();
    flushSync();
    expect(spec().type).toBe("bar");
    expect(q('[data-chart-node-view] [data-chart-type="bar"]')!.getAttribute("aria-checked")).toBe("true");
    click(q('[data-action="done"]')!);
    expect(q("[data-chart-node-toolbar]")).toBeNull();
  });

  it("shows agent and undo changes, and never opens in a read-only editor", () => {
    mount();
    editor!.commands.updateChart("c1", { spec: { ...SPEC, title: "Revised" } });
    flushSync();
    expect(q("[data-chart-node-view] svg")?.getAttribute("aria-label")).toContain("Revised");
    editor!.setEditable(false);
    flushSync();
    click(q("[data-chart-node-canvas]")!);
    expect(q("[data-chart-node-toolbar]")).toBeNull();
  });
});
