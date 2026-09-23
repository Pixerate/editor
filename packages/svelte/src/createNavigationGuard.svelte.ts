export interface CreateNavigationGuardOptions {
  /** Function or boolean returning whether there are unsaved changes */
  isDirty: boolean | (() => boolean);
  /** Whether guarding is enabled (defaults to true) */
  enabled?: boolean | (() => boolean);
  /** Optional custom navigation callback (e.g. SvelteKit goto) */
  onNavigate?: (url: string) => void;
  /** Optional callback fired when an internal navigation is intercepted */
  onBlocked?: (url: string) => void;
}

export interface NavigationGuardManager {
  readonly showConfirm: boolean;
  setShowConfirm(show: boolean): void;
  readonly pendingUrl: string | null;
  intercept(url: string): boolean;
  confirmLeave(): void;
  cancelLeave(): void;
  destroy(): void;
}

/**
 * Headless Svelte 5 rune managing navigation guard state and beforeunload interception.
 */
export function createNavigationGuard(
  options: CreateNavigationGuardOptions,
): NavigationGuardManager {
  let showConfirm = $state(false);
  let pendingUrl = $state<string | null>(null);

  const getIsDirty = () =>
    typeof options.isDirty === "function" ? options.isDirty() : options.isDirty;

  const getEnabled = () =>
    typeof options.enabled === "function"
      ? options.enabled()
      : (options.enabled ?? true);

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (!getEnabled() || !getIsDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", handleBeforeUnload);
  }

  function intercept(url: string): boolean {
    if (getEnabled() && getIsDirty()) {
      pendingUrl = url;
      showConfirm = true;
      options.onBlocked?.(url);
      return true;
    }
    return false;
  }

  function confirmLeave() {
    showConfirm = false;
    const target = pendingUrl;
    if (target) {
      if (options.onNavigate) {
        options.onNavigate(target);
      } else if (typeof window !== "undefined") {
        window.location.href = target;
      }
    }
  }

  function cancelLeave() {
    showConfirm = false;
    pendingUrl = null;
  }

  function destroy() {
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    }
  }

  return {
    get showConfirm() {
      return showConfirm;
    },
    setShowConfirm(val: boolean) {
      showConfirm = val;
    },
    get pendingUrl() {
      return pendingUrl;
    },
    intercept,
    confirmLeave,
    cancelLeave,
    destroy,
  };
}
