import React from "react";
import { RecoveryPrompt, useEditorAutosave } from "@pixerate/editor-react/persistence";
import type { EditorDocument } from "@pixerate/editor/persistence";
import { demoDocumentStorage } from "../agentTools";

/**
 * Crash-recovery autosave for any editor tab: pass the editor's `EditorDocument`
 * (e.g. `useMermaidDiagram().editorDocument`). Edits are snapshotted to IndexedDB;
 * reloading with unsaved changes offers to restore them.
 */
export const EditorDocumentAutosave: React.FC<{ doc: EditorDocument; name: string }> = ({ doc, name }) => {
  const autosave = useEditorAutosave(doc, { storage: demoDocumentStorage, key: `autosave:${doc.kind}`, name });
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
        onRestore={() => void autosave.restore()}
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
