import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useLinkFocus } from "../src";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: "https://example.com/" });
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

const links = { a: ["x"], b: ["x", "y"] };
const marks = [["a"], ["b"], ["x"], ["y"], ["a", "x"], ["b", "x"], ["b", "y"]];

function Picture() {
  const focus = useLinkFocus({ marks, links, dim: 0.2 });
  return (
    <div {...focus.rootProps} data-testid="root" tabIndex={-1}>
      {marks.map((keys, i) => (
        <button key={i} type="button" {...(keys.length === 1 ? focus.markProps(keys[0]) : {})} data-mark={keys.join("-")} style={{ opacity: focus.opacity(i) }} />
      ))}
      <p aria-live="polite">{focus.description}</p>
    </div>
  );
}

const opacities = () => [...container.querySelectorAll("[data-mark]")].map((el) => `${el.getAttribute("data-mark")}:${(el as HTMLElement).style.opacity}`);

describe("useLinkFocus", () => {
  it("lights a mark and its links on hover, and clears when the pointer leaves", async () => {
    await act(async () => root.render(<Picture />));
    const x = container.querySelector('[data-mark="x"]')!;
    // React builds pointerenter / pointerleave from pointerover / pointerout and their relatedTarget.
    await act(async () => x.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true, relatedTarget: null })));
    expect(opacities()).toEqual(["a:1", "b:1", "x:1", "y:0.2", "a-x:1", "b-x:1", "b-y:0.2"]);
    expect(container.querySelector("p")!.textContent).toBe("x, 3 of 4: linked to 2 others, a, b.");
    await act(async () => x.dispatchEvent(new window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(opacities().every((o) => o.endsWith(":1"))).toBe(true);
  });

  it("walks with the keyboard and clears with Escape", async () => {
    await act(async () => root.render(<Picture />));
    const rootEl = container.querySelector('[data-testid="root"]') as HTMLElement;
    const key = (k: string) => act(async () => rootEl.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
    await key("ArrowRight");
    expect(opacities()).toEqual(["a:1", "b:0.2", "x:1", "y:0.2", "a-x:1", "b-x:0.2", "b-y:0.2"]);
    await key("ArrowRight");
    expect(container.querySelector("p")!.textContent).toBe("b, 2 of 4: linked to 2 others, x, y.");
    await key("Escape");
    expect(opacities().every((o) => o.endsWith(":1"))).toBe(true);
    expect(container.querySelector("p")!.textContent).toBe("Nothing focused.");
  });

  it("focusing a mark focuses its key; focus leaving the picture clears", async () => {
    await act(async () => root.render(<Picture />));
    const y = container.querySelector('[data-mark="y"]') as HTMLElement;
    await act(async () => y.focus());
    expect(opacities()).toEqual(["a:0.2", "b:1", "x:0.2", "y:1", "a-x:0.2", "b-x:0.2", "b-y:1"]);
    await act(async () => y.blur());
    expect(opacities().every((o) => o.endsWith(":1"))).toBe(true);
  });
});
