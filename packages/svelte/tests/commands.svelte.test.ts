import { describe, it, expect, vi, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry, createHistoryCommands, type CommandSpec } from "@pixerate/editor/commands";
import {
  CommandPalette,
  HistoryManager,
  createCommandPalette,
  createCommandShortcuts,
  useRegisterCommands,
  type SvelteCommandPalette,
} from "../src";

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  flushSync();
  return event;
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

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

function mountPalette(palette: SvelteCommandPalette, props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(CommandPalette, { target, props: { palette, ...props } });
  flushSync();
  cleanup.push(() => {
    unmount(component);
    target.remove();
    palette.destroy();
  });
  return target;
}

const options = (root: Element) => Array.from(root.querySelectorAll('[role="option"]'));

describe("Svelte CommandPalette", () => {
  it("opens with the hotkey, filters, shows shortcuts and disabled reasons, and runs commands", () => {
    const { registry, history, ran, specs } = setup();
    registry.register(specs);
    registry.register(createHistoryCommands(history));
    const onRecentsChange = vi.fn();
    const palette = createCommandPalette(registry, { hotkey: "Mod+K", platform: "linux", onRecentsChange });
    const target = mountPalette(palette);
    expect(target.querySelector('[role="dialog"]')).toBeNull();

    const outside = document.createElement("input");
    document.body.appendChild(outside);
    const hotkey = keydown(outside, { code: "KeyK", key: "k", ctrlKey: true });
    outside.remove();
    expect(hotkey.defaultPrevented).toBe(true);
    expect(target.querySelector('[role="dialog"]')).not.toBeNull();

    const input = target.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(document.activeElement).toBe(input);
    expect(options(target).map((o) => o.getAttribute("data-command-id"))).toEqual([
      "doc.bold",
      "doc.italic",
      "history.undo",
      "history.redo",
    ]);
    expect(options(target)[0].querySelector("kbd")?.textContent).toBe("Ctrl+B");
    expect(options(target)[0].textContent).toContain("Format");
    const undo = options(target)[2];
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.querySelector("[data-disabled-reason]")?.textContent).toBe("Nothing to undo.");

    typeInto(input, "slant");
    expect(options(target).map((o) => o.getAttribute("data-command-id"))).toEqual(["doc.italic"]);
    typeInto(input, "bld");
    expect(options(target)[0].querySelectorAll("[data-match]")).toHaveLength(3);

    keydown(input, { key: "Enter" });
    expect(ran).toEqual(["bold"]);
    expect(target.querySelector('[role="dialog"]')).toBeNull();
    expect(onRecentsChange).toHaveBeenCalledWith(["doc.bold"]);
    expect(palette.recents).toEqual(["doc.bold"]);

    palette.setOpen(true);
    flushSync();
    expect(options(target)[0].hasAttribute("data-recent")).toBe(true);
    keydown(target.querySelector('input[role="combobox"]')!, { key: "ArrowDown" });
    expect(options(target)[1].getAttribute("aria-selected")).toBe("true");
    (options(target)[1] as HTMLElement).click();
    flushSync();
    expect(ran).toEqual(["bold", "italic"]);

    history.execute({ name: "x", execute: () => {}, undo: () => {} });
    registry.invalidate();
    palette.setOpen(true);
    flushSync();
    const undoRow = options(target).find((o) => o.getAttribute("data-command-id") === "history.undo")!;
    expect(undoRow.hasAttribute("aria-disabled")).toBe(false);
    keydown(target.querySelector('input[role="combobox"]')!, { key: "Escape" });
    expect(target.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes on a backdrop press and shows an empty state", () => {
    const { registry, specs } = setup();
    registry.register(specs);
    const palette = createCommandPalette(registry);
    const target = mountPalette(palette, { emptyMessage: "Nothing here" });
    palette.setOpen(true);
    flushSync();
    typeInto(target.querySelector<HTMLInputElement>('input[role="combobox"]')!, "zzzz");
    expect(target.textContent).toContain("Nothing here");
    target.querySelector("[data-command-palette-backdrop]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(palette.open).toBe(false);
  });
});

describe("Svelte command shortcuts and registration", () => {
  it("runs enabled commands from shortcuts by scope and skips text inputs", () => {
    const { registry, ran, specs } = setup();
    registry.register(specs);
    registry.register({ id: "canvas.lock", label: "Lock", scope: "canvas", shortcut: "Mod+L", run: () => ran.push("lock") });
    let scopes: string | undefined;
    const onRun = vi.fn();
    const shortcuts = createCommandShortcuts(registry, { scopes: () => scopes, onRun });
    cleanup.push(shortcuts.destroy);

    expect(keydown(window, { code: "KeyB", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(ran).toEqual(["bold"]);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id: "doc.bold" }));
    keydown(window, { code: "KeyL", ctrlKey: true });
    expect(ran).toEqual(["bold"]);
    scopes = "canvas";
    keydown(window, { code: "KeyL", ctrlKey: true });
    expect(ran).toEqual(["bold", "lock"]);

    const field = document.createElement("input");
    document.body.appendChild(field);
    keydown(field, { code: "KeyB", ctrlKey: true });
    field.remove();
    expect(ran).toEqual(["bold", "lock"]);

    shortcuts.destroy();
    keydown(window, { code: "KeyB", ctrlKey: true });
    expect(ran).toEqual(["bold", "lock"]);
  });

  it("useRegisterCommands registers while the effect is alive and follows getter changes", () => {
    const registry = new CommandRegistry();
    let specs = $state<CommandSpec[] | null>(null);
    const stop = $effect.root(() => {
      useRegisterCommands(registry, () => specs);
    });
    flushSync();
    expect(registry.ids()).toEqual([]);
    specs = [{ id: "a", label: "A", run: () => {} }];
    flushSync();
    expect(registry.ids()).toEqual(["a"]);
    specs = [{ id: "b", label: "B", run: () => {} }];
    flushSync();
    expect(registry.ids()).toEqual(["b"]);
    stop();
    expect(registry.ids()).toEqual([]);
  });
});
