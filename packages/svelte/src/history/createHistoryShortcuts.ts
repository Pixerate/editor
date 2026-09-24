import { HistoryManager } from "@pixerate/editor";

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
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const modifier = isMac ? e.metaKey : e.ctrlKey;

    if (!modifier) return;

    if (ignoreEditableElements && typeof document !== "undefined") {
      const targetEl = (e.target || document.activeElement) as HTMLElement | null;
      if (targetEl && targetEl.tagName) {
        const tagName = targetEl.tagName.toLowerCase();
        const isInput = tagName === "input" || tagName === "textarea";
        const isContentEditable =
          targetEl.isContentEditable ||
          targetEl.getAttribute?.("contenteditable") === "true";
        if (isInput || isContentEditable) {
          return;
        }
      }
    }

    const key = e.key?.toLowerCase();

    // Undo: Mod+Z (without Shift)
    if (key === "z" && !e.shiftKey) {
      if (manager.getState().canUndo) {
        e.preventDefault();
        manager.undo();
      }
      return;
    }

    // Redo: Mod+Shift+Z or (on non-Mac) Mod+Y
    const isRedoKey =
      (key === "z" && e.shiftKey) || (!isMac && key === "y" && !e.shiftKey);

    if (isRedoKey) {
      if (manager.getState().canRedo) {
        e.preventDefault();
        manager.redo();
      }
    }
  };

  eventTarget.addEventListener("keydown", handleKeyDown);

  return {
    destroy: () => {
      eventTarget.removeEventListener("keydown", handleKeyDown);
    },
  };
}
