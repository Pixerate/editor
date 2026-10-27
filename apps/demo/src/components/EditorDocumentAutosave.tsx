import React, { useEffect, useMemo } from "react";
import { useAgentToolProvider } from "@pixerate/editor-react";
import { RecoveryPrompt, useEditorAutosave } from "@pixerate/editor-react/persistence";
import { createDocumentToolProvider, type EditorDocument } from "@pixerate/editor/persistence";
import { demoDocumentStorage, demoDocumentStore, demoToolRegistry } from "../agentTools";

/**
 * An editor's `EditorDocument` for a demo tab, with its save / load tools registered while the
 * tab is mounted (`<namespace>__get_<kind>_document`, `…__save_<kind>_document`, …).
 */
export function useDemoEditorDocument<C, T>(
  controller: C,
  create: (controller: C) => EditorDocument<T>,
  tools: { namespace: string; skill: string; history?: boolean; name?: () => string | undefined },
): EditorDocument<T> {
  const doc = useMemo(() => create(controller), [controller, create]);
  useEffect(() => () => doc.destroy(), [doc]);
  useDemoDocumentTools(doc, tools);
  return doc;
}

/** Registers an `EditorDocument`'s save / load tools (with the demo's document store) while mounted. */
export function useDemoDocumentTools(
  doc: EditorDocument,
  tools: { namespace: string; skill: string; history?: boolean; name?: () => string | undefined },
): void {
  const provider = useMemo(
    () => createDocumentToolProvider(doc, { id: `${doc.kind}-document`, store: demoDocumentStore, ...tools }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc],
  );
  useAgentToolProvider(demoToolRegistry, provider);
}

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
