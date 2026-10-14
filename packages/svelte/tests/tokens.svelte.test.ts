import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { TokenStore, findTokenVariable } from "@pixerate/editor/tokens";
import { TokensPanel, createTokens } from "../src/tokens";
import { TokenBindingPicker, TokenModeSwitcher, createCanvasTokens } from "../src/canvas";
import type { CanvasNode } from "../src/canvas/types";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function themeStore() {
  let n = 0;
  const store = new TokenStore({ createId: (kind) => `${kind}-${++n}` });
  const c = store.createCollection("Theme", ["Light", "Dark"]);
  const bg = store.createVariable({ collectionId: c.id, name: "color/bg", type: "color", values: { Light: "#ffffff", Dark: "#111111" } });
  const space = store.createVariable({ collectionId: c.id, name: "space", type: "number", values: { Light: 8, Dark: 12 } });
  return { store, c, bg, space, light: c.modes[0], dark: c.modes[1] };
}

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

const q = <T extends Element = HTMLElement>(root: Element, sel: string) => root.querySelector(sel) as T;

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

function commit(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new FocusEvent("blur"));
  flushSync();
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
}

describe("createTokens", () => {
  it("exposes state and CSS variables per mode, and follows edits", () => {
    const { store, c, bg, dark } = themeStore();
    let modes: Record<string, string> = {};
    const tokens = createTokens(store, { modes: () => modes });
    cleanups.push(tokens.destroy);
    expect(tokens.cssVariables["--color-bg"]).toBe("#ffffff");
    expect(tokens.style).toContain("--color-bg: #ffffff");
    expect(tokens.css).toContain(':root[data-mode="dark"]');
    store.setValue(bg.id, "#eeeeee");
    expect(tokens.state).toBe(store.getState());
    expect(tokens.cssVariables["--color-bg"]).toBe("#eeeeee");
    expect(tokens.canUndo).toBe(true);
    tokens.undo();
    expect(tokens.cssVariables["--color-bg"]).toBe("#ffffff");
    modes = { [c.id]: dark.id };
    store.setValue(bg.id, "#222222", dark.id);
    expect(tokens.cssVariables["--color-bg"]).toBe("#222222");
  });
});

describe("TokensPanel (Svelte)", () => {
  it("shows modes as columns with swatches and edits values, names, aliases and modes", () => {
    const { store, bg, space, light, dark } = themeStore();
    const root = render(TokensPanel, { store });
    const headers = [...root.querySelectorAll("thead th[data-mode-id] input")].map((i) => (i as HTMLInputElement).value);
    expect(headers).toEqual(["Light", "Dark"]);
    expect(q(root, `td[data-variable-id="${bg.id}"][data-mode-id="${dark.id}"] [data-token-swatch]`).getAttribute("data-token-swatch")).toBe("#111111");

    commit(q(root, `td[data-variable-id="${space.id}"][data-mode-id="${dark.id}"] input`), "16");
    expect(store.getState().variables[1].valuesByMode[dark.id]).toBe(16);
    commit(q(root, 'input[aria-label="Variable space name"]'), "space/md");
    expect(findTokenVariable(store.getState(), "space/md")?.id).toBe(space.id);

    type(q(root, 'input[aria-label="New variable name"]'), "surface");
    submit(q<HTMLInputElement>(root, 'input[aria-label="New variable name"]').closest("form")!);
    const surface = findTokenVariable(store.getState(), "surface")!;
    expect(surface.type).toBe("color");
    choose(q(root, 'select[aria-label="surface alias in Dark"]'), bg.id);
    expect(store.getState().variables.find((v) => v.id === surface.id)!.valuesByMode[dark.id]).toEqual({ alias: bg.id });
    expect(q(root, `td[data-variable-id="${surface.id}"][data-mode-id="${dark.id}"] [data-token-alias]`).textContent).toContain("color/bg");

    choose(q(root, 'select[aria-label="color/bg alias in Dark"]'), surface.id);
    expect(q(root, '[role="alert"]').textContent).toContain("cycle");
    expect(store.getState().variables[0].valuesByMode[dark.id]).toBe("#111111");

    choose(q(root, 'select[aria-label="surface alias in Dark"]'), "");
    expect(store.getState().variables.find((v) => v.id === surface.id)!.valuesByMode[dark.id]).toBe("#111111");

    type(q(root, 'input[aria-label="New mode name"]'), "Dim");
    submit(q<HTMLInputElement>(root, 'input[aria-label="New mode name"]').closest("form")!);
    expect(store.getState().collections[0].modes.map((m) => m.name)).toEqual(["Light", "Dark", "Dim"]);
    q<HTMLButtonElement>(root, 'button[aria-label="Make Dim the default mode"]').click();
    flushSync();
    expect(store.getState().collections[0].modes[0].name).toBe("Dim");
    q<HTMLButtonElement>(root, 'button[aria-label="Remove mode Dim"]').click();
    flushSync();
    expect(store.getState().collections[0].modes.map((m) => m.id)).toEqual([light.id, dark.id]);

    q<HTMLButtonElement>(root, 'button[aria-label="Undo token edit"]').click();
    flushSync();
    expect(store.getState().collections[0].modes).toHaveLength(3);

    q<HTMLButtonElement>(root, 'button[aria-label="Delete variable surface"]').click();
    flushSync();
    expect(findTokenVariable(store.getState(), "surface")).toBeUndefined();
  });

  it("creates collections", () => {
    const store = new TokenStore();
    const root = render(TokensPanel, { store });
    expect(root.textContent).toContain("No collections yet.");
    type(q(root, 'input[aria-label="New collection name"]'), "Brand");
    submit(q<HTMLInputElement>(root, 'input[aria-label="New collection name"]').closest("form")!);
    expect(store.getState().collections.map((c) => c.name)).toEqual(["Brand"]);
    expect(q<HTMLSelectElement>(root, 'select[aria-label="Collection"]').value).toBe(store.getState().collections[0].id);
  });
});

describe("canvas tokens (Svelte)", () => {
  const initial = (): CanvasNode[] => [
    { id: "card", position: { x: 0, y: 0 }, data: { layout: { mode: "vertical" } }, style: "background-color: #cccccc" },
    { id: "swatch", parentId: "card", position: { x: 0, y: 0 }, data: { shape: { kind: "rect", fill: "#000000" } } },
  ];

  it("createCanvasTokens binds, switches modes, follows edits and detaches on delete", () => {
    const { store, c, bg, space, dark } = themeStore();
    let nodes = initial();
    const tokens = createCanvasTokens({ store, getNodes: () => nodes, setNodes: (next) => (nodes = next) });
    cleanups.push(tokens.destroy);
    const fill = () => nodes.find((n) => n.id === "swatch")!.data.shape.fill;
    tokens.bind(["swatch"], "fill", bg.id);
    expect(fill()).toBe("#ffffff");
    tokens.bind(["card"], "fill", bg.id);
    expect(nodes[0].style).toBe("background-color: #ffffff");
    expect(() => tokens.bind(["card"], "gap", bg.id)).toThrow(/takes a number/);
    tokens.bind(["card"], "gap", space.id);
    expect(nodes[0].data.layout.gap).toBe(8);

    tokens.setMode(["card"], c.id, dark.id);
    expect(fill()).toBe("#111111");
    expect(nodes[0].data.layout.gap).toBe(12);
    expect(tokens.modesOf("swatch")).toEqual({ [c.id]: dark.id });

    store.setValue(bg.id, "#333333", dark.id);
    expect(fill()).toBe("#333333");
    store.undo();
    expect(fill()).toBe("#111111");

    store.deleteVariables(bg.id);
    expect(fill()).toBe("#111111");
    expect(nodes[1].data.tokenBindings).toBeUndefined();
    expect(tokens.state).toBe(store.getState());
  });

  it("TokenBindingPicker and TokenModeSwitcher bind and switch through onchange", () => {
    const { store, bg, dark } = themeStore();
    const state = { nodes: initial() };
    const props = $state({
      state: store.getState(),
      nodes: state.nodes,
      selectedIds: ["swatch"],
      nodeIds: ["card"],
      onchange: (next: CanvasNode[]) => {
        props.nodes = next;
      },
    });
    const picker = render(TokenBindingPicker, props);
    const switcher = render(TokenModeSwitcher, props);
    const options = [...q<HTMLSelectElement>(picker, 'select[aria-label="Fill variable"]').options].map((o) => o.textContent);
    expect(options).toEqual(["None", "color/bg"]);
    expect([...q<HTMLSelectElement>(picker, 'select[aria-label="Corner radius variable"]').options].map((o) => o.textContent)).toEqual(["None", "space"]);

    choose(q(picker, 'select[aria-label="Fill variable"]'), bg.id);
    const fill = () => props.nodes.find((n) => n.id === "swatch")!.data.shape.fill;
    expect(fill()).toBe("#ffffff");
    expect(q(picker, '[data-token-property="fill"] [data-token-resolved] span').getAttribute("title")).toBe("#ffffff");

    expect(q<HTMLSelectElement>(switcher, 'select[aria-label="Theme mode"]').options[0].textContent).toBe("Auto (Light)");
    choose(q(switcher, 'select[aria-label="Theme mode"]'), dark.id);
    expect(fill()).toBe("#111111");
    expect(q<HTMLSelectElement>(switcher, 'select[aria-label="Theme mode"]').value).toBe(dark.id);
    choose(q(switcher, 'select[aria-label="Theme mode"]'), "");
    expect(props.nodes[0].data.tokenModes).toBeUndefined();
  });
});
