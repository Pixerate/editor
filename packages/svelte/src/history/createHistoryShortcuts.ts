import type { HistoryManager } from "@pixerate/editor/history";
import { matchHistoryShortcut } from "@pixerate/editor/commands";

export interface HistoryShortcutsOptions {
  /**
   * Whether keyboard shortcuts are enabled. Defaults to true.
   */
  enabled?: boolean;
  /**
   * Target element or window to listen on. Defaults to window.
   */
  target?: Window | HTMLElement | null;
  /**
   * When true (default), shortcuts will not trigger if an <input>, <textarea>,
   * or [contenteditable] element is currently active / focused.
   */
  ignoreEditableElements?: boolean;
}

/**
 * Attaches keyboard listeners for Undo (Mod+Z) and Redo (Mod+Shift+Z / Mod+Y).
 * Returns an object with a `destroy()` function for lifecycle cleanup.
 */
export function createHistoryShortcuts(
  manager: HistoryManager,
  options: HistoryShortcutsOptions = {},
): { destroy: () => void } {
  const {
    enabled = true,
    target,
    ignoreEditableElements = true,
  } = options;

  if (!enabled) {
    return { destroy: () => {} };
  }

  const eventTarget = target ?? (typeof window !== "undefined" ? window : null);
  if (!eventTarget) {
    return { destroy: () => {} };
  }

  const handleKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    // Default bindings from the command system: Mod+Z, Mod+Shift+Z and (off macOS) Mod+Y,
    // matched by `event.code` with `Mod` = ⌘ on macOS and Ctrl elsewhere.
    const action = matchHistoryShortcut(e, { allowInEditable: !ignoreEditableElements });
    if (action === "undo" && manager.getState().canUndo) {
      e.preventDefault();
      manager.undo();
    } else if (action === "redo" && manager.getState().canRedo) {
      e.preventDefault();
      manager.redo();
    }
  };

  eventTarget.addEventListener("keydown", handleKeyDown);

  return {
    destroy: () => {
      eventTarget.removeEventListener("keydown", handleKeyDown);
    },
  };
}
