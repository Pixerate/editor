import { useCallback, useMemo, useState } from "react";
import {
  extractVariables,
  matchFields,
  mergeRecords,
  parseDataSource,
  recordToValues,
  serializeMergeOutputs,
  type MergeDataSource,
  type MergeRecord,
  type MergeRecordsOptions,
  type MergeRecordsResult,
  type ParseDataSourceOptions,
  type PromptValues,
  type Template,
} from "@pixerate/editor";

export interface UseMergePreviewOptions {
  /** The prompt merged with each record. */
  template: string;
  templates?: Template[];
  bindings?: Record<string, string>;
  /** Initial CSV / TSV / JSON text. */
  initialSource?: string;
  /** How to read the data source text. */
  parseOptions?: ParseDataSourceOptions;
  /** Passed to `mergeRecords` by `merge()`. */
  skipIf?: MergeRecordsOptions["skipIf"];
  separator?: string;
  maxOutputs?: number;
}

export interface MergePreviewState {
  sourceText: string;
  setSourceText: (text: string) => void;
  /** Reads a picked file (CSV, TSV or JSON) into `sourceText`. */
  loadFile: (file: Blob) => Promise<void>;
  source: MergeDataSource;
  /** Variable names the template uses, in order. */
  variables: string[];
  /** Variable → field: automatic matches with the user's overrides applied. */
  mapping: Record<string, string | null>;
  setFieldMapping: (variable: string, field: string | null) => void;
  resetMapping: () => void;
  /** 0-based index of the previewed record. */
  index: number;
  count: number;
  setIndex: (index: number) => void;
  next: () => void;
  prev: () => void;
  record: MergeRecord | undefined;
  /** Prompt values for the previewed record. */
  values: PromptValues;
  /** Merges every record with the current mapping and stores the result. */
  merge: () => MergeRecordsResult;
  result: MergeRecordsResult | null;
  /** The last merge's outputs as text or JSON. */
  serialize: (format: "text" | "json") => string;
}

/**
 * Headless state for a mail-merge preview (the counterpart of Svelte's
 * `createMergePreview`): parses a pasted or loaded data source, matches its
 * fields to the template's variables (editable), steps through records and
 * merges them all with `mergeRecords`.
 */
export function useMergePreview(options: UseMergePreviewOptions): MergePreviewState {
  const { template, templates, bindings, parseOptions } = options;
  const [sourceText, setSourceTextState] = useState(options.initialSource ?? "");
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [index, setIndexState] = useState(0);
  const [result, setResult] = useState<MergeRecordsResult | null>(null);

  const source = useMemo(
    () => parseDataSource(sourceText, parseOptions),
    [sourceText, parseOptions],
  );
  const variables = useMemo(
    () => extractVariables(template, { templates, bindings }).map((v) => v.name),
    [template, templates, bindings],
  );
  const mapping = useMemo(() => {
    const merged: Record<string, string | null> = {
      ...matchFields(variables, source.fields).mapping,
    };
    for (const [variable, field] of Object.entries(overrides)) {
      if (variables.includes(variable) && (field === null || source.fields.includes(field))) {
        merged[variable] = field;
      }
    }
    return merged;
  }, [variables, source.fields, overrides]);

  const count = source.records.length;
  const current = count === 0 ? 0 : Math.min(index, count - 1);
  const record = source.records[current];
  const values = useMemo(
    () => (record ? recordToValues(record, mapping) : {}),
    [record, mapping],
  );

  const setSourceText = useCallback((text: string) => {
    setSourceTextState(text);
    setIndexState(0);
    setResult(null);
  }, []);
  const loadFile = useCallback(
    async (file: Blob) => setSourceText(await file.text()),
    [setSourceText],
  );
  const setIndex = useCallback(
    (next: number) => setIndexState(Math.max(0, Math.min(next, count - 1))),
    [count],
  );
  const setFieldMapping = useCallback((variable: string, field: string | null) => {
    setOverrides((previous) => ({ ...previous, [variable]: field }));
    setResult(null);
  }, []);
  const resetMapping = useCallback(() => setOverrides({}), []);

  const merge = useCallback(() => {
    const merged = mergeRecords(template, source, {
      templates,
      bindings,
      mapping,
      skipIf: options.skipIf,
      separator: options.separator,
      maxOutputs: options.maxOutputs,
    });
    setResult(merged);
    return merged;
  }, [template, source, templates, bindings, mapping, options.skipIf, options.separator, options.maxOutputs]);

  const serialize = useCallback(
    (format: "text" | "json") =>
      result ? serializeMergeOutputs(result.outputs, format, options.separator) : "",
    [result, options.separator],
  );

  return {
    sourceText,
    setSourceText,
    loadFile,
    source,
    variables,
    mapping,
    setFieldMapping,
    resetMapping,
    index: current,
    count,
    setIndex,
    next: () => setIndex(current + 1),
    prev: () => setIndex(current - 1),
    record,
    values,
    merge,
    result,
    serialize,
  };
}
