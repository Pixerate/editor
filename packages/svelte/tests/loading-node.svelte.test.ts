import { describe, it, expect, afterEach } from "vitest";
import { flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { LoadingNode } from "@pixerate/editor";
import { createSvelteLoadingNodeView } from "../src";
import LoadingProbe from "./fixtures/LoadingProbe.svelte";

let editor: Editor | null = null;
let element: HTMLDivElement;

afterEach(() => {
  editor?.destroy();
  editor = null;
  element?.remove();
});

describe("Svelte loading node view", () => {
  it("mounts the component inside the accessible placeholder and follows id changes", () => {
    element = document.createElement("div");
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: [StarterKit, LoadingNode.configure({ label: "Generating", nodeView: createSvelteLoadingNodeView(LoadingProbe) })],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "loadingNode", attrs: { id: "job-1" } }] }] },
    });
    flushSync();
    const placeholder = element.querySelector('span[data-type="loading"]') as HTMLElement;
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.getAttribute("aria-label")).toBe("Generating");
    expect(placeholder.querySelector("svg")).toBeNull();
    const probe = () => element.querySelector(".probe-loader") as HTMLElement;
    expect(probe().dataset.job).toBe("job-1");
    expect(probe().textContent).toBe("Generating");

    editor.view.dispatch(editor.state.tr.setNodeAttribute(1, "id", "job-2"));
    flushSync();
    expect(probe().dataset.job).toBe("job-2");

    editor.commands.setContent("<p>done</p>");
    flushSync();
    expect(element.querySelector(".probe-loader")).toBeNull();
  });
});
