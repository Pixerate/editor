import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createCommandPaletteController,
  matchPaletteHotkey,
  type CommandPaletteController,
  type CommandPaletteOptions,
  type CommandPaletteState,
  type CommandRegistry,
} from '@pixerate/editor/commands';

export interface UseCommandPaletteOptions<TContext = any> extends CommandPaletteOptions<TContext> {
  /** Chord that toggles the palette from anywhere, also while typing (e.g. `Mod+K`). */
  hotkey?: string;
  /** Element or window the hotkey listens on (default: `window`). */
  hotkeyTarget?: Window | HTMLElement | null;
}

export interface UseCommandPaletteResult extends CommandPaletteState {
  controller: CommandPaletteController;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => void;
  run: CommandPaletteController['run'];
  runActive: CommandPaletteController['runActive'];
  handleKeyDown: CommandPaletteController['handleKeyDown'];
}

/**
 * Command palette state over a `CommandRegistry` (ranked rows with shortcuts and
 * disabled reasons, active row, recents). Render it with `<CommandPalette palette={…} />`
 * or your own UI. Options are read live; the registry identity is the dependency.
 */
export function useCommandPalette<TContext = any>(
  registry: CommandRegistry<TContext>,
  options: UseCommandPaletteOptions<TContext> = {},
): UseCommandPaletteResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controller = useMemo(
    () =>
      createCommandPaletteController(registry, {
        context: () => {
          const c = optionsRef.current.context;
          if (c === undefined) return registry.context;
          return (typeof c === 'function' ? (c as () => TContext)() : c) as TContext;
        },
        scope: () => {
          const s = optionsRef.current.scope;
          return typeof s === 'function' ? s() : s;
        },
        recents: options.recents,
        recentLimit: options.recentLimit,
        limit: options.limit,
        platform: options.platform,
        onRecentsChange: (recents) => optionsRef.current.onRecentsChange?.(recents),
        onRun: (result) => optionsRef.current.onRun?.(result),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const { hotkey, hotkeyTarget } = options;
  useEffect(() => {
    if (!hotkey) return;
    const target = hotkeyTarget ?? (typeof window !== 'undefined' ? window : null);
    if (!target) return;
    const onKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.defaultPrevented || !matchPaletteHotkey(e, hotkey, optionsRef.current.platform)) return;
      e.preventDefault();
      controller.toggle();
    };
    target.addEventListener('keydown', onKeyDown);
    return () => target.removeEventListener('keydown', onKeyDown);
  }, [controller, hotkey, hotkeyTarget]);

  return {
    ...state,
    controller,
    setOpen: controller.setOpen,
    toggle: controller.toggle,
    setQuery: controller.setQuery,
    setActiveIndex: controller.setActiveIndex,
    move: controller.move,
    run: controller.run,
    runActive: controller.runActive,
    handleKeyDown: controller.handleKeyDown,
  };
}
