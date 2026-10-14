import type { CommandRegistry, CommandResult, CommandSpec } from "@pixerate/editor/commands";

type MaybeGetter<T> = T | (() => T);

const read = <T>(value: MaybeGetter<T>): T =>
  typeof value === "function" ? (value as () => T)() : value;

export interface CommandShortcutsOptions<TContext = any> {
  /** Element or window to listen on (default: `window`). */
  target?: Window | HTMLElement | null;
  /** Active scopes, most specific first; a getter is read on every keydown. */
  scopes?: MaybeGetter<string | readonly string[] | undefined>;
  /** Context for the commands (default: the registry's); a getter is read on every keydown. */
  context?: MaybeGetter<TContext | undefined>;
  /** Fire even while typing in inputs / contenteditable (default: per binding). */
  allowInEditable?: boolean;
  /** Called after a shortcut ran a command. */
  onRun?: (result: CommandResult) => void;
}

/**
 * Runs the registry's commands from their keyboard shortcuts (`registry.handleKeyDown`).
 * Typing in inputs and editors is never hijacked, and disabled commands leave the event
 * alone. Returns `{ destroy }`.
 */
export function createCommandShortcuts<TContext = any>(
  registry: CommandRegistry<TContext>,
  options: CommandShortcutsOptions<TContext> = {},
): { destroy: () => void } {
  const target = options.target ?? (typeof window !== "undefined" ? window : null);
  if (!target) return { destroy: () => {} };
  const onKeyDown = (event: Event) => {
    const context = options.context === undefined ? undefined : read(options.context);
    const result = registry.handleKeyDown(event as KeyboardEvent, {
      scopes: options.scopes === undefined ? undefined : read(options.scopes),
      ...(options.allowInEditable !== undefined ? { allowInEditable: options.allowInEditable } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    if (result) options.onRun?.(result);
  };
  target.addEventListener("keydown", onKeyDown);
  return { destroy: () => target.removeEventListener("keydown", onKeyDown) };
}

/**
 * Registers commands for the lifetime of the calling component (call it during
 * component initialisation). Pass a getter to react to changes: when it returns a
 * different array, the old commands are unregistered.
 */
export function useRegisterCommands<TContext = any>(
  registry: MaybeGetter<CommandRegistry<TContext> | null | undefined>,
  specs: MaybeGetter<readonly CommandSpec<TContext>[] | null | undefined>,
): void {
  $effect(() => {
    const currentRegistry = read(registry);
    const currentSpecs = read(specs);
    if (!currentRegistry || !currentSpecs || currentSpecs.length === 0) return;
    return currentRegistry.register(currentSpecs);
  });
}
