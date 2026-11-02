// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { LoadingNode, loadingSpinnerSpec, type LoadingNodeViewState } from "../src";

const created: Editor[] = [];
afterEach(() => {
  for (const editor of created.splice(0)) if (!editor.isDestroyed) editor.destroy();
});

function createEditor(loading = LoadingNode, element?: HTMLElement) {
  const editor = new Editor({
    element,
    extensions: [StarterKit, loading],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "A " }, { type: "loadingNode", attrs: { id: "job-1" } }] }],
    },
  });
  created.push(editor);
  return editor;
}

const placeholderIn = (root: ParentNode) => root.querySelector('span[data-type="loading"]') as HTMLElement;

describe("LoadingNode", () => {
  it("serializes an accessible SVG spinner instead of an emoji", () => {
    const html = createEditor().getHTML();
    expect(html).not.toContain("⏳");
    const host = document.createElement("div");
    host.innerHTML = html;
    const placeholder = placeholderIn(host);
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.getAttribute("aria-label")).toBe("Loading…");
    expect(placeholder.getAttribute("data-id")).toBe("job-1");
    expect(placeholder.className).toContain("text-muted-foreground");
    const svg = placeholder.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("circle")?.getAttribute("stroke")).toBe("currentColor");
    expect(svg.querySelector("animateTransform")).not.toBeNull();
  });

  it("draws the spinner in the SVG namespace in the editor", () => {
    const element = document.createElement("div");
    createEditor(LoadingNode, element);
    const svg = placeholderIn(element).querySelector("svg")!;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("path")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("parses its own HTML back into a placeholder with the same id", () => {
    const html = createEditor().getHTML();
    const editor = createEditor();
    editor.commands.setContent(html);
    let found: unknown = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "loadingNode") found = node.attrs.id;
    });
    expect(found).toBe("job-1");
  });

  it("takes a label, extra attributes and a custom indicator", () => {
    const element = document.createElement("div");
    const editor = createEditor(
      LoadingNode.configure({
        label: "Generating",
        HTMLAttributes: { class: "my-loader" },
        renderIndicator: () => ["span", { class: "dots" }, "…"],
      }),
      element,
    );
    for (const root of [element, Object.assign(document.createElement("div"), { innerHTML: editor.getHTML() })]) {
      const placeholder = placeholderIn(root);
      expect(placeholder.getAttribute("aria-label")).toBe("Generating");
      expect(placeholder.className).toContain("my-loader");
      expect(placeholder.className).toContain("inline-flex");
      expect(placeholder.querySelector(".dots")?.textContent).toBe("…");
      expect(placeholder.querySelector("svg")).toBeNull();
    }
  });

  it("mounts a framework node view with the id and label, updates and destroys it", () => {
    const states: LoadingNodeViewState[] = [];
    const destroy = vi.fn();
    const element = document.createElement("div");
    const editor = createEditor(
      LoadingNode.configure({
        nodeView: (dom, state) => {
          states.push(state);
          dom.append(Object.assign(document.createElement("i"), { className: "custom-loader" }));
          return { update: (next) => states.push(next), destroy };
        },
      }),
      element,
    );
    const placeholder = placeholderIn(element);
    expect(states[0]).toEqual({ id: "job-1", label: "Loading…" });
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.querySelector(".custom-loader")).not.toBeNull();
    expect(placeholder.querySelector("svg")).toBeNull();
    // getHTML keeps the static indicator.
    expect(editor.getHTML()).toContain("<svg");

    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === "loadingNode") pos = p;
    });
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "id", "job-2"));
    expect(states.at(-1)).toEqual({ id: "job-2", label: "Loading…" });
    expect(placeholderIn(element).getAttribute("data-id")).toBe("job-2");

    editor.commands.setContent("<p>done</p>");
    expect(destroy).toHaveBeenCalled();
  });

  it("exports the default spinner spec", () => {
    const spec = loadingSpinnerSpec() as unknown[];
    expect(spec[0]).toBe("http://www.w3.org/2000/svg svg");
  });
});
