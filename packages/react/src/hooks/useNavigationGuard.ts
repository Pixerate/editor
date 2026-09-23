import { useState, useEffect, useCallback, useRef } from "react";

export interface UseNavigationGuardOptions {
  /** Whether the current form or editor has unsaved changes */
  isDirty: boolean;
  /** Whether guarding is enabled (defaults to true) */
  enabled?: boolean;
  /** Custom navigation function (e.g. router.push from next/navigation or react-router) */
  onNavigate?: (url: string) => void;
  /** Optional callback fired when an internal navigation attempt is intercepted */
  onBlocked?: (url: string) => void;
}

export interface UseNavigationGuardReturn {
  /** Whether the unsaved changes confirmation dialog should be displayed */
  showConfirm: boolean;
  /** Setter to manually control the dialog visibility */
  setShowConfirm: (show: boolean) => void;
  /** The target URL that the user attempted to navigate to */
  pendingUrl: string | null;
  /** Proceeds with the blocked navigation and closes the dialog */
  confirmLeave: () => void;
  /** Cancels the navigation attempt and keeps the user on the current page */
  cancelLeave: () => void;
}

/**
 * Hook to guard against navigation when there are unsaved changes.
 * Intercepts both external unloads (tab closing/refreshing) and internal link clicks.
 */
export function useNavigationGuard({
  isDirty,
  enabled = true,
  onNavigate,
  onBlocked,
}: UseNavigationGuardOptions): UseNavigationGuardReturn {
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  // 1. Intercept external navigation / tab close (beforeunload)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled || !isDirty) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled, isDirty]);

  // 2. Intercept internal anchor link clicks
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined")
      return;
    if (!enabled || !isDirty) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a");

      if (!anchor) return;
      if (anchor.target === "_blank") return;

      // Only guard internal origins
      const isInternal = anchor.host === window.location.host;
      if (!isInternal) return;

      // Ignore navigation to the exact same path & query
      if (
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const href = anchor.href;
      setPendingUrl(href);
      setShowConfirm(true);
      onBlockedRef.current?.(href);
    };

    document.addEventListener("click", handleClick, { capture: true });
    return () => {
      document.removeEventListener("click", handleClick, { capture: true });
    };
  }, [enabled, isDirty]);

  const confirmLeave = useCallback(() => {
    setShowConfirm(false);
    if (pendingUrl) {
      if (onNavigateRef.current) {
        onNavigateRef.current(pendingUrl);
      } else if (typeof window !== "undefined") {
        window.location.href = pendingUrl;
      }
    }
  }, [pendingUrl]);

  const cancelLeave = useCallback(() => {
    setShowConfirm(false);
    setPendingUrl(null);
  }, []);

  return {
    showConfirm,
    setShowConfirm,
    pendingUrl,
    confirmLeave,
    cancelLeave,
  };
}
