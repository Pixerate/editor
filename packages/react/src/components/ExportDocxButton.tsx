import React from "react";
import type { Editor } from "@tiptap/core";
import type { DocxExportControllerOptions, DocxExportReport } from "@pixerate/editor/export";
import { useDocxExport } from "../hooks/useDocxExport";

export interface ExportDocxButtonProps extends DocxExportControllerOptions {
  editor: Editor | null;
  className?: string;
  children?: React.ReactNode;
  /** Called after the download with the export report. */
  onExported?: (report: DocxExportReport) => void;
}

/** A button that downloads the editor's document as a Word file (`.docx`). */
export const ExportDocxButton: React.FC<ExportDocxButtonProps> = ({
  editor,
  className = "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50",
  children = "Export to Word",
  onExported,
  ...options
}) => {
  const docx = useDocxExport(editor, options);
  return (
    <button
      type="button"
      className={className}
      disabled={!editor || docx.isExporting}
      aria-busy={docx.isExporting || undefined}
      title={docx.error ? `Export failed: ${docx.error.message}` : undefined}
      onClick={async () => {
        const report = await docx.download();
        if (report) onExported?.(report);
      }}
    >
      {children}
    </button>
  );
};
