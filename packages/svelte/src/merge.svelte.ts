import {
  extractVariables,
  matchFields,
  mergeRecords,
  parseDataSource,
  recordToValues,
  serializeMergeOutputs,
  type MergeRecordsOptions,
  type MergeRecordsResult,
  type ParseDataSourceOptions,
  type Template,
} from "@pixerate/editor";

export interface MergePreviewOptions {
  /** The prompt merged with each record. */
  template: string;
  templates?: Template[];
  bindings?: Record<string, string>;
  /** How to read the data source text. */
  parseOptions?: ParseDataSourceOptions;
  /** Passed to `mergeRecords` by `merge()`. */
  skipIf?: MergeRecordsOptions["skipIf"];
  separator?: string;
  maxOutputs?: number;
}

/**
 * Reactive mail-merge preview state for Svelte 5 (the counterpart of React's
 * `useMergePreview`): parses a pasted or loaded data source, matches its
 * fields to the template's variables (editable), steps through records and
 * merges them all with `mergeRecords`.
 *
 * `getOptions` is read reactively, so pass `() => ({ template, templates })`
 * built from props or state.
 */
export function createMergePreview(
  getOptions: () => MergePreviewOptions,
  initialSource = "",
) {
  let sourceText = $state(initialSource);
  let overrides = $state.raw<Record<string, string | null>>({});
  let index = $state(0);
  let result = $state.raw<MergeRecordsResult | null>(null);

  const options = $derived(getOptions());
  const source = $derived(parseDataSource(sourceText, options.parseOptions));
  const variables = $derived(
    extractVariables(options.template, {
      templates: options.templates,
      bindings: options.bindings,
    }).map((v) => v.name),
  );
  const mapping = $derived.by(() => {
    const merged: Record<string, string | null> = {
      ...matchFields(variables, source.fields).mapping,
    };
    for (const [variable, field] of Object.entries(overrides)) {
      if (variables.includes(variable) && (field === null || source.fields.includes(field))) {
        merged[variable] = field;
      }
    }
    return merged;
  });
  const count = $derived(source.records.length);
  const current = $derived(count === 0 ? 0 : Math.min(index, count - 1));
  const record = $derived(source.records[current]);
  const values = $derived(record ? recordToValues(record, mapping) : {});

  function setSourceText(text: string) {
    sourceText = text;
    index = 0;
    result = null;
  }
  function setIndex(next: number) {
    index = Math.max(0, Math.min(next, count - 1));
  }

  return {
    get sourceText() {
      return sourceText;
    },
    set sourceText(text: string) {
      setSourceText(text);
    },
    setSourceText,
    /** Reads a picked file (CSV, TSV or JSON) into `sourceText`. */
    async loadFile(file: Blob) {
      setSourceText(await file.text());
    },
    get source() {
      return source;
    },
    /** Variable names the template uses, in order. */
    get variables() {
      return variables;
    },
    /** Variable → field: automatic matches with the user's overrides applied. */
    get mapping() {
      return mapping;
    },
    setFieldMapping(variable: string, field: string | null) {
      overrides = { ...overrides, [variable]: field };
      result = null;
    },
    resetMapping() {
      overrides = {};
    },
    /** 0-based index of the previewed record. */
    get index() {
      return current;
    },
    get count() {
      return count;
    },
    setIndex,
    next() {
      setIndex(current + 1);
    },
    prev() {
      setIndex(current - 1);
    },
    get record() {
      return record;
    },
    /** Prompt values for the previewed record. */
    get values() {
      return values;
    },
    /** Merges every record with the current mapping and stores the result. */
    merge(): MergeRecordsResult {
      const merged = mergeRecords(options.template, source, {
        templates: options.templates,
        bindings: options.bindings,
        mapping,
        skipIf: options.skipIf,
        separator: options.separator,
        maxOutputs: options.maxOutputs,
      });
      result = merged;
      return merged;
    },
    get result() {
      return result;
    },
    /** The last merge's outputs as text or JSON. */
    serialize(format: "text" | "json"): string {
      return result ? serializeMergeOutputs(result.outputs, format, options.separator) : "";
    },
  };
}

export type MergePreviewState = ReturnType<typeof createMergePreview>;
