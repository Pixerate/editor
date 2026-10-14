<script lang="ts">
  import { formatRecoveryMessage, type RecoveryMeta } from '@pixerate/editor/persistence';

  interface Props {
    /** `createAutosave(...).recovery`; nothing renders while it is `null`. */
    recovery: { meta: RecoveryMeta } | null;
    onRestore: () => void;
    onDiscard: () => void;
    /** Formats the snapshot time (default `toLocaleString`). */
    formatTime?: (time: number) => string;
    restoreLabel?: string;
    discardLabel?: string;
    class?: string;
  }

  let {
    recovery,
    onRestore,
    onDiscard,
    formatTime,
    restoreLabel = 'Restore',
    discardLabel = 'Discard',
    class: className = ''
  }: Props = $props();
</script>

{#if recovery}
  <div
    role="alertdialog"
    aria-label="Unsaved changes found"
    data-recovery-prompt=""
    class="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm {className}"
  >
    <span class="min-w-0 flex-1">
      {formatRecoveryMessage(recovery.meta, formatTime)}
      {#if recovery.meta.name}
        <span class="ml-1 text-xs text-muted-foreground">({recovery.meta.name})</span>
      {/if}
    </span>
    <button
      type="button"
      data-recovery-restore=""
      onclick={onRestore}
      class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
    >
      {restoreLabel}
    </button>
    <button
      type="button"
      data-recovery-discard=""
      onclick={onDiscard}
      class="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
    >
      {discardLabel}
    </button>
  </div>
{/if}
