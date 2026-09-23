export interface NavigationGuardOptions {
  /** Whether the current form or editor has unsaved changes */
  isDirty: boolean;
  /** Whether guarding is enabled (defaults to true) */
  enabled?: boolean;
  /** Callback fired when an internal navigation attempt is intercepted */
  onBlocked?: (url: string) => void;
}

export interface NavigationGuardActionReturn {
  update(newOptions: NavigationGuardOptions): void;
  destroy(): void;
}

/**
 * Svelte action to guard against navigation when there are unsaved changes.
 * Attaches beforeunload to window and intercepts internal anchor clicks on the element.
 *
 * Usage:
 * <div use:navigationGuard={{ isDirty, onBlocked: (url) => { pendingUrl = url; showConfirm = true; } }}>
 */
export function navigationGuard(
  node: HTMLElement,
  options: NavigationGuardOptions,
): NavigationGuardActionReturn {
  let isDirty = options.isDirty;
  let enabled = options.enabled ?? true;
  let onBlocked = options.onBlocked;

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (!enabled || !isDirty) return;
    e.preventDefault();
    e.returnValue = "";
  }

  function handleClick(e: MouseEvent) {
    if (!enabled || !isDirty) return;

    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.("a");
    if (!anchor) return;
    if (anchor.target === "_blank") return;

    // Check if link is internal
    if (typeof window !== "undefined") {
      const isInternal = anchor.host === window.location.host;
      if (!isInternal) return;

      if (
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search
      ) {
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();

    const href = anchor.href;
    onBlocked?.(href);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", handleBeforeUnload);
  }
  node.addEventListener("click", handleClick, { capture: true });

  return {
    update(newOptions: NavigationGuardOptions) {
      isDirty = newOptions.isDirty;
      enabled = newOptions.enabled ?? true;
      onBlocked = newOptions.onBlocked;
    },
    destroy() {
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", handleBeforeUnload);
      }
      node.removeEventListener("click", handleClick, { capture: true });
    },
  };
}
