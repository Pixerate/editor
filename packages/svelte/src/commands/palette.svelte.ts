import {
  createCommandPaletteController,
  matchPaletteHotkey,
  type CommandPaletteController,
  type CommandPaletteItem,
  type CommandPaletteOptions,
  type CommandPaletteState,
  type CommandRegistry,
  type CommandResult,
} from "@pixerate/editor/commands";

export interface CreateCommandPaletteOptions<TContext = any> extends CommandPaletteOptions<TContext> {
  /** Chord that toggles the palette from anywhere, also while typing (e.g. `Mod+K`). */
  hotkey?: string;
  /** Element or window the hotkey listens on (default: `window`). */
  hotkeyTarget?: Window | HTMLElement | null;
}

export interface SvelteCommandPalette {
  readonly open: boolean;
  readonly query: string;
  readonly activeIndex: number;
  readonly items: CommandPaletteItem[];
  readonly recents: string[];
  readonly lastResult: CommandResult | null;
  readonly controller: CommandPaletteController;
  setOpen(open: boolean): void;
  toggle(): void;
  setQuery(query: string): void;
  setActiveIndex(index: number): void;
  move(delta: number): void;
  run(id: string): CommandResult | null;
  runActive(): CommandResult | null;
  handleKeyDown(event: KeyboardEvent): boolean;
  /** Stops following the registry and removes the hotkey listener. */
  destroy(): void;
}

/**
 * Reactive command palette state over a `CommandRegistry` (Svelte 5 runes): ranked rows
 * with shortcuts and disabled reasons, active row and recents. Render it with
 * `<CommandPalette palette={…} />` or your own markup. Call `destroy()` when done
 * (e.g. in `onDestroy`).
 */
export function createCommandPalette<TContext = any>(
  registry: CommandRegistry<TContext>,
  options: CreateCommandPaletteOptions<TContext> = {},
): SvelteCommandPalette {
  const controller = createCommandPaletteController(registry, options);
  let state = $state.raw<CommandPaletteState>(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state = next;
  });

  let removeHotkey = () => {};
  const { hotkey } = options;
  const target = options.hotkeyTarget ?? (typeof window !== "undefined" ? window : null);
  if (hotkey && target) {
    const onKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.defaultPrevented || !matchPaletteHotkey(e, hotkey, options.platform)) return;
      e.preventDefault();
      controller.toggle();
    };
    target.addEventListener("keydown", onKeyDown);
    removeHotkey = () => target.removeEventListener("keydown", onKeyDown);
  }

  return {
    get open() {
      return state.open;
    },
    get query() {
      return state.query;
    },
    get activeIndex() {
      return state.activeIndex;
    },
    get items() {
      return state.items;
    },
    get recents() {
      return state.recents;
    },
    get lastResult() {
      return state.lastResult;
    },
    controller,
    setOpen: controller.setOpen,
    toggle: controller.toggle,
    setQuery: controller.setQuery,
    setActiveIndex: controller.setActiveIndex,
    move: controller.move,
    run: controller.run,
    runActive: controller.runActive,
    handleKeyDown: controller.handleKeyDown,
    destroy() {
      unsubscribe();
      removeHotkey();
    },
  };
}
