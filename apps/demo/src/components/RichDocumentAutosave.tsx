import React, { useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { RecoveryPrompt, useAutosave } from "@pixerate/editor-react/persistence";
import {
  createLocalStorageAdapter,
  createMemoryStorage,
  isLocalStorageAvailable,
} from "@pixerate/editor/persistence";

/**
 * Crash-recovery autosave for the Rich Document tab: edits are snapshotted to
 * localStorage; reloading with unsaved changes offers to restore them.
 */
export const RichDocumentAutosave: React.FC<{ editor: Editor }> = ({ editor }) => {
  const storage = useMemo(
    () => (isLocalStorageAvailable() ? createLocalStorageAdapter("pixerate-demo:") : createMemoryStorage()),
    []
  );
  // Every TipTap update is a new revision.
  const changes = useMemo(
    () => ({
      subscribe(listener: () => void) {
        editor.on("update", listener);
        return () => {
          editor.off("update", listener);
        };
      },
    }),
    [editor]
  );

  const autosave = useAutosave<{ html: string }>({
    storage,
    key: "rich-document",
    name: "Rich Document",
    getSnapshot: () => ({ html: editor.getHTML() }),
    history: changes,
  });

  const { status, failures } = autosave.status;
  const label =
    status === "saved" ? "Recovery snapshot saved" :
    status === "saving" ? "Saving recovery snapshot…" :
    status === "dirty" ? "Unsaved changes" :
    status === "error" ? `Snapshot failed (${failures}), retrying` :
    "No unsaved changes";

  return (
    <div className="space-y-2">
      <RecoveryPrompt
        recovery={autosave.recovery}
        className="!bg-slate-900 !border-amber-500/40 !text-slate-100"
        onRestore={() => {
          const snapshot = autosave.restore();
          if (snapshot) editor.commands.setContent(snapshot.html, true);
        }}
        onDiscard={() => void autosave.discard()}
      />
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span data-autosave-status={status}>{label}</span>
        <button
          type="button"
          className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800"
          onClick={() => void autosave.markClean()}
          title="Pretend the document was saved: retires the recovery snapshot"
        >
          Mark saved
        </button>
      </div>
    </div>
  );
};
