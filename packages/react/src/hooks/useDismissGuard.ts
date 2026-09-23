import { useState, useCallback, useRef } from "react";

export interface UseDismissGuardOptions {
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** Whether the dismissal guard is enabled (defaults to true) */
  enabled?: boolean;
  /** Callback fired when dismissal is confirmed or when clean dismissal occurs */
  onDismiss?: () => void;
}

export interface UseDismissGuardReturn {
  /** Whether the discard confirmation modal should be shown */
  showConfirm: boolean;
  /** Manually update confirmation modal visibility */
  setShowConfirm: (show: boolean) => void;
  /** Request dismissal - checks isDirty and shows confirm or executes onDismiss */
  requestDismiss: () => void;
  /** Confirm discarding changes and dismiss */
  confirmDismiss: () => void;
  /** Cancel discarding and resume editing */
  cancelDismiss: () => void;
  /** Helper keydown handler intercepting Escape key */
  handleKeyDown: (event: React.KeyboardEvent | KeyboardEvent) => boolean;
}

/**
 * Hook to guard against closing or exiting an editor/dialog with uncommitted changes.
 */
export function useDismissGuard({
  isDirty,
  enabled = true,
  onDismiss,
}: UseDismissGuardOptions): UseDismissGuardReturn {
  const [showConfirm, setShowConfirm] = useState(false);

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const requestDismiss = useCallback(() => {
    if (enabled && isDirty) {
      setShowConfirm(true);
    } else {
      onDismissRef.current?.();
    }
  }, [enabled, isDirty]);

  const confirmDismiss = useCallback(() => {
    setShowConfirm(false);
    onDismissRef.current?.();
  }, []);

  const cancelDismiss = useCallback(() => {
    setShowConfirm(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent | KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.defaultPrevented) return false;
        event.preventDefault();
        requestDismiss();
        return true;
      }
      return false;
    },
    [requestDismiss],
  );

  return {
    showConfirm,
    setShowConfirm,
    requestDismiss,
    confirmDismiss,
    cancelDismiss,
    handleKeyDown,
  };
}
