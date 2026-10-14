import React from 'react';
import { formatRecoveryMessage, type RecoveryMeta } from '@pixerate/editor/persistence';

export interface RecoveryPromptProps {
  /** `useAutosave().recovery`; nothing renders while it is `null`. */
  recovery: { meta: RecoveryMeta } | null;
  onRestore: () => void;
  onDiscard: () => void;
  /** Formats the snapshot time (default `toLocaleString`). */
  formatTime?: (time: number) => string;
  restoreLabel?: string;
  discardLabel?: string;
  className?: string;
}

/**
 * "Restore unsaved changes from <time>?" banner with Restore / Discard buttons
 * (Tailwind + theme tokens).
 */
export const RecoveryPrompt: React.FC<RecoveryPromptProps> = ({
  recovery,
  onRestore,
  onDiscard,
  formatTime,
  restoreLabel = 'Restore',
  discardLabel = 'Discard',
  className = '',
}) => {
  if (!recovery) return null;
  const { name } = recovery.meta;
  return (
    <div
      role="alertdialog"
      aria-label="Unsaved changes found"
      data-recovery-prompt=""
      className={`flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm ${className}`}
    >
      <span className="min-w-0 flex-1">
        {formatRecoveryMessage(recovery.meta, formatTime)}
        {name ? <span className="ml-1 text-xs text-muted-foreground">({name})</span> : null}
      </span>
      <button
        type="button"
        data-recovery-restore=""
        onClick={onRestore}
        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        {restoreLabel}
      </button>
      <button
        type="button"
        data-recovery-discard=""
        onClick={onDiscard}
        className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
      >
        {discardLabel}
      </button>
    </div>
  );
};
