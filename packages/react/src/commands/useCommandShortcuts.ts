import { useEffect, useRef } from 'react';
import type { CommandRegistry, CommandResult, CommandSpec } from '@pixerate/editor/commands';

export interface UseCommandShortcutsOptions<TContext = any> {
  /** Default `true`. */
  enabled?: boolean;
  /** Element or window to listen on (default: `window`). */
  target?: Window | HTMLElement | null;
  /** Active scopes, most specific first (e.g. `'canvas'` while the canvas has focus). */
  scopes?: string | readonly string[];
  /** Context for the commands (default: the registry's). */
  context?: TContext;
  /** Fire even while typing in inputs / contenteditable (default: per binding). */
  allowInEditable?: boolean;
  /** Called after a shortcut ran a command. */
  onRun?: (result: CommandResult) => void;
}

/**
 * Runs the registry's commands from their keyboard shortcuts (`registry.handleKeyDown`).
 * Typing in inputs and editors is never hijacked, and disabled commands leave the
 * event alone. Options are read live.
 */
export function useCommandShortcuts<TContext = any>(
  registry: CommandRegistry<TContext> | null | undefined,
  options: UseCommandShortcutsOptions<TContext> = {},
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled = true, target } = options;

  useEffect(() => {
    if (!registry || !enabled) return;
    const eventTarget = target ?? (typeof window !== 'undefined' ? window : null);
    if (!eventTarget) return;
    const onKeyDown = (event: Event) => {
      const { scopes, context, allowInEditable, onRun } = optionsRef.current;
      const result = registry.handleKeyDown(event as KeyboardEvent, {
        scopes,
        ...(allowInEditable !== undefined ? { allowInEditable } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      if (result) onRun?.(result);
    };
    eventTarget.addEventListener('keydown', onKeyDown);
    return () => eventTarget.removeEventListener('keydown', onKeyDown);
  }, [registry, enabled, target]);
}

/**
 * Registers commands while the component is mounted. Memoize `specs` (e.g. with
 * `useMemo(() => createHistoryCommands(manager), [manager])`): a new array re-registers.
 */
export function useRegisterCommands<TContext = any>(
  registry: CommandRegistry<TContext> | null | undefined,
  specs: readonly CommandSpec<TContext>[] | null | undefined,
): void {
  useEffect(() => {
    if (!registry || !specs || specs.length === 0) return;
    return registry.register(specs);
  }, [registry, specs]);
}
