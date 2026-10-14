import React, { useId, useState } from "react";
import type {
  ColorGradient,
  MergeRecordsOptions,
  MergeRecordsResult,
  ParseDataSourceOptions,
  Template,
} from "@pixerate/editor";
import { TemplateRenderer } from "./TemplateRenderer";
import { useMergePreview } from "../hooks/useMergePreview";

export interface MergePreviewProps {
  /** The prompt merged with each record. */
  content: string;
  templates?: Template[];
  bindings?: Record<string, string>;
  templateColorMap?: Map<string, ColorGradient>;
  /** Initial CSV / TSV / JSON data source text. */
  defaultSource?: string;
  parseOptions?: ParseDataSourceOptions;
  /** Drop records matching this condition (e.g. `"status=void"`) when merging. */
  skipIf?: MergeRecordsOptions["skipIf"];
  /** Separator between merged outputs (default a blank line; `"none"` for nothing). */
  separator?: string;
  maxOutputs?: number;
  /** Called after "Merge all". */
  onMerge?: (result: MergeRecordsResult) => void;
  /** Base file name for downloads (default `merged`). */
  downloadName?: string;
  className?: string;
}

/** Saves text as a file through a temporary link. */
function downloadText(text: string, fileName: string, type: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Mail-merge preview: paste or pick a CSV / JSON data source, check the
 * automatic field mapping, step through records with the resolved prompt
 * shown by `TemplateRenderer`, and merge every record into text or JSON.
 */
export const MergePreview: React.FC<MergePreviewProps> = ({
  content,
  templates,
  bindings,
  templateColorMap,
  defaultSource,
  parseOptions,
  skipIf,
  separator,
  maxOutputs,
  onMerge,
  downloadName = "merged",
  className = "flex flex-col gap-3 text-sm",
}) => {
  const id = useId();
  const merge = useMergePreview({
    template: content,
    templates,
    bindings,
    initialSource: defaultSource,
    parseOptions,
    skipIf,
    separator,
    maxOutputs,
  });
  const [copied, setCopied] = useState(false);
  const { source, result } = merge;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(merge.serialize("text"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={className} data-merge-preview="">
      <label htmlFor={`${id}-source`} className="flex flex-col gap-1">
        <span className="font-medium">Data source (CSV, TSV or JSON)</span>
        <textarea
          id={`${id}-source`}
          data-merge-source=""
          value={merge.sourceText}
          rows={5}
          spellCheck={false}
          onChange={(event) => merge.setSourceText(event.target.value)}
          className="px-2 py-1 font-mono text-xs rounded-md border border-violet-400/40 bg-transparent"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,application/json"
          aria-label="Load data source file"
          data-merge-file=""
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void merge.loadFile(file);
          }}
        />
        <span data-merge-summary="" className="opacity-70">
          {`${source.records.length} record${source.records.length === 1 ? "" : "s"} · ${source.fields.length} field${source.fields.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {source.warnings.length > 0 && merge.sourceText.trim() !== "" && (
        <ul data-merge-warnings="" className="text-amber-600 text-xs">
          {source.warnings.map((warning, i) => (
            <li key={i}>{warning.message}</li>
          ))}
        </ul>
      )}

      {merge.variables.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">Field mapping</legend>
          {merge.variables.map((variable) => (
            <label
              key={variable}
              className="flex items-center gap-2"
              data-merge-mapping={variable}
            >
              <span className="min-w-24 font-mono">{`{${variable}}`}</span>
              <select
                value={merge.mapping[variable] ?? ""}
                aria-label={`Field for ${variable}`}
                onChange={(event) =>
                  merge.setFieldMapping(variable, event.target.value || null)
                }
                className="px-1 py-0.5 rounded-md border border-violet-400/40 bg-transparent"
              >
                <option value="">(none)</option>
                {source.fields.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-merge-prev=""
          onClick={merge.prev}
          disabled={merge.index <= 0}
        >
          Prev
        </button>
        <span data-merge-position="">
          {merge.count === 0
            ? "No records"
            : `Record ${merge.index + 1} of ${merge.count}`}
        </span>
        <button
          type="button"
          data-merge-next=""
          onClick={merge.next}
          disabled={merge.index >= merge.count - 1}
        >
          Next
        </button>
      </div>

      <div data-merge-output="">
        <TemplateRenderer
          content={content}
          templates={templates}
          bindings={bindings}
          templateColorMap={templateColorMap}
          resolve={!!templates && templates.length > 0}
          values={merge.values}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-merge-all=""
          disabled={merge.count === 0}
          onClick={() => {
            const merged = merge.merge();
            setCopied(false);
            onMerge?.(merged);
          }}
        >
          Merge all
        </button>
        {result && (
          <>
            <span data-merge-result="">
              {`${result.outputs.length} merged${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}${result.truncated ? " (stopped early)" : ""}`}
            </span>
            <button type="button" data-merge-copy="" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              data-merge-download="text"
              onClick={() => downloadText(merge.serialize("text"), `${downloadName}.txt`, "text/plain")}
            >
              Download .txt
            </button>
            <button
              type="button"
              data-merge-download="json"
              onClick={() =>
                downloadText(merge.serialize("json"), `${downloadName}.json`, "application/json")
              }
            >
              Download .json
            </button>
          </>
        )}
      </div>
      {result && (
        <textarea
          readOnly
          aria-label="Merged output"
          data-merge-text=""
          rows={6}
          value={merge.serialize("text")}
          className="px-2 py-1 font-mono text-xs rounded-md border border-violet-400/40 bg-transparent"
        />
      )}
    </div>
  );
};
