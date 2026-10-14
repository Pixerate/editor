// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { TokenStore, findTokenVariable } from "@pixerate/editor/tokens";
import { TokensPanel, useTokens, useTokenStore, type UseTokensResult } from "../src/tokens";
import { TokenBindingPicker, TokenModeSwitcher, useCanvasTokens, type CanvasNode, type CanvasTokens } from "../src/canvas";

let container: HTMLDivElement;
let root: any;
const dom = { window: globalThis.window as any };

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

function themeStore() {
  let n = 0;
  const store = new TokenStore({ createId: (kind) => `${kind}-${++n}` });
  const c = store.createCollection("Theme", ["Light", "Dark"]);
  const bg = store.createVariable({ collectionId: c.id, name: "color/bg", type: "color", values: { Light: "#ffffff", Dark: "#111111" } });
  const space = store.createVariable({ collectionId: c.id, name: "space", type: "number", values: { Light: 8, Dark: 12 } });
  return { store, c, bg, space, light: c.modes[0], dark: c.modes[1] };
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function commit(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

describe("useTokens", () => {
  it("exposes state and CSS variables per mode, and follows edits", async () => {
    const { store, c, bg, dark } = themeStore();
    const ref: { result: UseTokensResult | null; modes: Record<string, string> } = { result: null, modes: {} };
    function Test({ modes }: { modes: Record<string, string> }) {
      ref.result = useTokens(store, { modes });
      return <div data-theme-root="" style={ref.result.cssVariables as React.CSSProperties} />;
    }
    await act(async () => root.render(<Test modes={{}} />));
    expect(ref.result!.cssVariables["--color-bg"]).toBe("#ffffff");
    expect(ref.result!.css).toContain(':root[data-mode="dark"]');
    expect(q("[data-theme-root]").style.getPropertyValue("--color-bg")).toBe("#ffffff");
    await act(async () => root.render(<Test modes={{ [c.id]: dark.id }} />));
    expect(ref.result!.cssVariables["--color-bg"]).toBe("#111111");
    await act(async () => store.setValue(bg.id, "#222222", dark.id));
    expect(ref.result!.cssVariables["--color-bg"]).toBe("#222222");
    expect(ref.result!.canUndo).toBe(true);
    await act(async () => ref.result!.undo());
    expect(ref.result!.cssVariables["--color-bg"]).toBe("#111111");
  });

  it("useTokenStore keeps one store across renders", async () => {
    const seen = new Set<TokenStore>();
    function Test({ n }: { n: number }) {
      seen.add(useTokenStore());
      return <span>{n}</span>;
    }
    await act(async () => root.render(<Test n={1} />));
    await act(async () => root.render(<Test n={2} />));
    expect(seen.size).toBe(1);
  });
});

describe("TokensPanel", () => {
  it("shows modes as columns with swatches and edits values, names, aliases and modes", async () => {
    const { store, bg, space, light, dark } = themeStore();
    await act(async () => root.render(<TokensPanel store={store} />));
    const headers = [...container.querySelectorAll("thead th[data-mode-id] input")].map((i) => (i as HTMLInputElement).value);
    expect(headers).toEqual(["Light", "Dark"]);
    expect(q(`td[data-variable-id="${bg.id}"][data-mode-id="${dark.id}"] [data-token-swatch]`).getAttribute("data-token-swatch")).toBe("#111111");

    // Edit a value.
    await commit(q(`td[data-variable-id="${space.id}"][data-mode-id="${dark.id}"] input`), "16");
    expect(store.getState().variables[1].valuesByMode[dark.id]).toBe(16);
    // Rename a variable.
    await commit(q('input[aria-label="Variable space name"]'), "space/md");
    expect(findTokenVariable(store.getState(), "space/md")?.id).toBe(space.id);

    // Add a variable and alias it to color/bg in Dark.
    await type(q('input[aria-label="New variable name"]'), "surface");
    await submit(q<HTMLFormElement>('input[aria-label="New variable name"]').closest("form")!);
    const surface = findTokenVariable(store.getState(), "surface")!;
    expect(surface.type).toBe("color");
    await choose(q(`select[aria-label="surface alias in Dark"]`), bg.id);
    expect(store.getState().variables.find((v) => v.id === surface.id)!.valuesByMode[dark.id]).toEqual({ alias: bg.id });
    expect(q(`td[data-variable-id="${surface.id}"][data-mode-id="${dark.id}"] [data-token-alias]`).textContent).toContain("color/bg");

    // A cycle is refused and shown.
    await choose(q(`select[aria-label="color/bg alias in Dark"]`), surface.id);
    expect(q('[role="alert"]').textContent).toContain("cycle");
    expect(store.getState().variables[0].valuesByMode[dark.id]).toBe("#111111");

    // Detach the alias back to its value.
    await choose(q(`select[aria-label="surface alias in Dark"]`), "");
    expect(store.getState().variables.find((v) => v.id === surface.id)!.valuesByMode[dark.id]).toBe("#111111");

    // Add a mode; make it the default; remove it.
    await type(q('input[aria-label="New mode name"]'), "Dim");
    await submit(q<HTMLFormElement>('input[aria-label="New mode name"]').closest("form")!);
    expect(store.getState().collections[0].modes.map((m) => m.name)).toEqual(["Light", "Dark", "Dim"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Make Dim the default mode"]').click());
    expect(store.getState().collections[0].modes[0].name).toBe("Dim");
    await act(async () => q<HTMLButtonElement>('button[aria-label="Remove mode Dim"]').click());
    expect(store.getState().collections[0].modes.map((m) => m.id)).toEqual([light.id, dark.id]);

    // Undo from the panel.
    await act(async () => q<HTMLButtonElement>('button[aria-label="Undo token edit"]').click());
    expect(store.getState().collections[0].modes).toHaveLength(3);

    // Delete a variable.
    await act(async () => q<HTMLButtonElement>('button[aria-label="Delete variable surface"]').click());
    expect(findTokenVariable(store.getState(), "surface")).toBeUndefined();
  });

  it("creates collections", async () => {
    const store = new TokenStore();
    await act(async () => root.render(<TokensPanel store={store} />));
    expect(container.textContent).toContain("No collections yet.");
    await type(q('input[aria-label="New collection name"]'), "Brand");
    await submit(q<HTMLFormElement>('input[aria-label="New collection name"]').closest("form")!);
    expect(store.getState().collections.map((c) => c.name)).toEqual(["Brand"]);
    expect(q<HTMLSelectElement>('select[aria-label="Collection"]').value).toBe(store.getState().collections[0].id);
  });
});

describe("canvas tokens", () => {
  const initial = (): CanvasNode[] => [
    { id: "card", position: { x: 0, y: 0 }, data: { layout: { mode: "vertical" } }, style: { backgroundColor: "#cccccc" } },
    { id: "swatch", parentId: "card", position: { x: 0, y: 0 }, data: { shape: { kind: "rect", fill: "#000000" } } },
  ];

  function renderCanvas(store: TokenStore) {
    const ref: { nodes: CanvasNode[]; tokens: CanvasTokens | null; selected: string[] } = { nodes: [], tokens: null, selected: ["swatch"] };
    function Test() {
      const [nodes, setNodes] = useState(initial);
      const [selected] = useState(ref.selected);
      ref.nodes = nodes;
      ref.tokens = useCanvasTokens({ store, nodes, setNodes });
      return (
        <>
          <TokenBindingPicker state={ref.tokens.state} nodes={nodes} selectedIds={selected} onChange={setNodes} />
          <TokenModeSwitcher state={ref.tokens.state} nodes={nodes} nodeIds={["card"]} onChange={setNodes} />
        </>
      );
    }
    return { ref, Test };
  }

  it("binds properties from the picker, switches a frame's mode, follows edits and detaches on delete", async () => {
    const { store, bg, dark } = themeStore();
    const { ref, Test } = renderCanvas(store);
    await act(async () => root.render(<Test />));
    const fill = () => ref.nodes.find((n) => n.id === "swatch")!.data.shape.fill;
    const options = [...q<HTMLSelectElement>('select[aria-label="Fill variable"]').options].map((o) => o.textContent);
    expect(options).toEqual(["None", "color/bg"]);
    // Number variables are offered for number properties only.
    expect([...q<HTMLSelectElement>('select[aria-label="Corner radius variable"]').options].map((o) => o.textContent)).toEqual(["None", "space"]);

    await choose(q('select[aria-label="Fill variable"]'), bg.id);
    expect(fill()).toBe("#ffffff");
    expect(q('[data-token-property="fill"] [data-token-resolved] span').getAttribute("title")).toBe("#ffffff");

    // The mode switcher on the frame: descendants follow.
    expect(q<HTMLSelectElement>('select[aria-label="Theme mode"]').options[0].textContent).toBe("Auto (Light)");
    await choose(q('select[aria-label="Theme mode"]'), dark.id);
    expect(fill()).toBe("#111111");
    expect(ref.tokens!.modesOf("swatch")).toEqual({ [store.getState().collections[0].id]: dark.id });

    // Token edits re-resolve bound nodes.
    await act(async () => store.setValue(bg.id, "#333333", dark.id));
    expect(fill()).toBe("#333333");

    // Deleting the variable keeps the value and drops the binding.
    await act(async () => void store.deleteVariables(bg.id));
    expect(fill()).toBe("#333333");
    expect(ref.nodes.find((n) => n.id === "swatch")!.data.tokenBindings).toBeUndefined();
    expect(q<HTMLSelectElement>('select[aria-label="Fill variable"]').value).toBe("");

    // Back to Auto.
    await choose(q('select[aria-label="Theme mode"]'), "");
    expect(ref.nodes.find((n) => n.id === "card")!.data.tokenModes).toBeUndefined();
  });

  it("bind() validates synchronously and frame properties reach auto layout data", async () => {
    const { store, bg, space } = themeStore();
    const { ref, Test } = renderCanvas(store);
    await act(async () => root.render(<Test />));
    expect(() => ref.tokens!.bind(["card"], "gap", bg.id)).toThrow(/takes a number/);
    await act(async () => ref.tokens!.bind(["card"], "gap", space.id));
    expect(ref.nodes[0].data.layout.gap).toBe(8);
    await act(async () => ref.tokens!.bind(["card"], "fill", bg.id));
    expect(ref.nodes[0].style.backgroundColor).toBe("#ffffff");
  });
});
