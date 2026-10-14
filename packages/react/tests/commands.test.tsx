// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  CommandRegistry,
  createHistoryCommands,
  type CommandSpec,
} from "@pixerate/editor/commands";
import {
  CommandPalette,
  HistoryManager,
  useCommandPalette,
  useCommandShortcuts,
  useRegisterCommands,
  type UseCommandPaletteResult,
} from "../src";

let container: HTMLDivElement;
let root: any;

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

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const options = () => Array.from(container.querySelectorAll('[role="option"]'));

function setup() {
  const registry = new CommandRegistry({ shortcuts: { platform: "linux" } });
  const history = new HistoryManager();
  const ran: string[] = [];
  const specs: CommandSpec[] = [
    { id: "doc.bold", label: "Bold", group: "Format", shortcut: "Mod+B", run: () => ran.push("bold") },
    { id: "doc.italic", label: "Italic", group: "Format", keywords: ["slanted"], run: () => ran.push("italic") },
  ];
  return { registry, history, ran, specs };
}

describe("React CommandPalette", () => {
  it("opens with the hotkey, filters, shows shortcuts and disabled reasons, and runs commands", async () => {
    const { registry, history, ran, specs } = setup();
    let palette: UseCommandPaletteResult | null = null;
    const onRecentsChange = vi.fn();

    function App() {
      const historySpecs = useMemo(() => createHistoryCommands(history), []);
      useRegisterCommands(registry, specs);
      useRegisterCommands(registry, historySpecs);
      palette = useCommandPalette(registry, { hotkey: "Mod+K", platform: "linux", onRecentsChange });
      return <CommandPalette palette={palette} />;
    }
    await render(<App />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // The hotkey works even while typing in an input.
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    const hotkey = await keydown(outside, { code: "KeyK", key: "k", ctrlKey: true });
    expect(hotkey.defaultPrevented).toBe(true);
    outside.remove();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(document.activeElement).toBe(input);
    expect(options().map((o) => o.getAttribute("data-command-id"))).toEqual([
      "doc.bold",
      "doc.italic",
      "history.undo",
      "history.redo",
    ]);
    const bold = options()[0];
    expect(bold.querySelector("kbd")?.textContent).toBe("Ctrl+B");
    expect(bold.textContent).toContain("Format");
    const undo = options()[2];
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.querySelector("[data-disabled-reason]")?.textContent).toBe("Nothing to undo.");

    await type(input, "slant");
    expect(options().map((o) => o.getAttribute("data-command-id"))).toEqual(["doc.italic"]);
    await type(input, "bld");
    expect(options()[0].querySelectorAll("[data-match]")).toHaveLength(3);

    await keydown(input, { key: "Enter" });
    expect(ran).toEqual(["bold"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onRecentsChange).toHaveBeenCalledWith(["doc.bold"]);
    expect(palette!.recents).toEqual(["doc.bold"]);

    // Reopen: recents first, arrows move, clicks run.
    await act(async () => palette!.setOpen(true));
    expect(options()[0].hasAttribute("data-recent")).toBe(true);
    await keydown(container.querySelector('input[role="combobox"]')!, { key: "ArrowDown" });
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    await act(async () => (options()[1] as HTMLElement).click());
    expect(ran).toEqual(["bold", "italic"]);

    // Enablement follows the history.
    await act(async () => {
      history.execute({ name: "x", execute: () => {}, undo: () => {} });
      registry.invalidate();
      palette!.setOpen(true);
    });
    const undoRow = options().find((o) => o.getAttribute("data-command-id") === "history.undo")!;
    expect(undoRow.hasAttribute("aria-disabled")).toBe(false);
    await keydown(container.querySelector('input[role="combobox"]')!, { key: "Escape" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes on a backdrop press and shows an empty state", async () => {
    const { registry, specs } = setup();
    registry.register(specs);
    let palette: UseCommandPaletteResult | null = null;
    function App() {
      palette = useCommandPalette(registry);
      return <CommandPalette palette={palette} emptyMessage="Nothing here" />;
    }
    await render(<App />);
    await act(async () => palette!.setOpen(true));
    await type(container.querySelector<HTMLInputElement>('input[role="combobox"]')!, "zzzz");
    expect(container.textContent).toContain("Nothing here");
    const backdrop = container.querySelector("[data-command-palette-backdrop]")!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(palette!.open).toBe(false);
  });
});

describe("React useCommandShortcuts", () => {
  it("runs enabled commands from shortcuts by scope and skips text inputs", async () => {
    const { registry, ran, specs } = setup();
    registry.register(specs);
    registry.register({ id: "canvas.lock", label: "Lock", scope: "canvas", shortcut: "Mod+L", run: () => ran.push("lock") });
    const onRun = vi.fn();
    function App({ scopes }: { scopes?: string }) {
      useCommandShortcuts(registry, { scopes, onRun });
      return <input id="field" />;
    }
    await render(<App />);
    const bold = await keydown(window, { code: "KeyB", ctrlKey: true });
    expect(bold.defaultPrevented).toBe(true);
    expect(ran).toEqual(["bold"]);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id: "doc.bold" }));

    await keydown(window, { code: "KeyL", ctrlKey: true });
    expect(ran).toEqual(["bold"]);
    await render(<App scopes="canvas" />);
    await keydown(window, { code: "KeyL", ctrlKey: true });
    expect(ran).toEqual(["bold", "lock"]);

    await keydown(container.querySelector("#field")!, { code: "KeyB", ctrlKey: true });
    expect(ran).toEqual(["bold", "lock"]);
  });
});
