// Portions ported from wordcraft/crates/engine/src/cmd/mailings.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See
// THIRD_PARTY_NOTICES.md.

/**
 * Multi-record merge: resolves one prompt per data source record with
 * `resolvePrompt`, like Word's Finish & Merge.
 */
import type { PromptDiagnostic, PromptValues, Template } from "./tokens";
import type { SourceMapSegment } from "./sourcemap";
import { resolvePrompt } from "./engine";
import { extractVariables } from "./fields";
import {
  evaluateConditionExpression,
  parseConditionExpression,
} from "./variables";
import {
  matchFields,
  parseDataSource,
  recordToValues,
  type DataSourceInput,
  type MergeDataSource,
  type MergeRecord,
  type ParseDataSourceOptions,
} from "./data-source";

/** Default cap on merged outputs. */
export const MAX_MERGE_OUTPUTS = 10_000;
/** Default cap on the total length of merged text (characters). */
export const MAX_MERGE_LENGTH = 20_000_000;

export interface MergeRecordsOptions {
  /** Templates for `{{name}}` tags. */
  templates?: Template[];
  /** Template version bindings. */
  bindings?: Record<string, string>;
  /** Maximum template nesting depth (default 10). */
  maxDepth?: number;
  /**
   * Variable → field. Variables left out are matched automatically with
   * `matchFields`; a `null` entry leaves the variable unset.
   */
  mapping?: Record<string, string | null>;
  /**
   * Text placed between outputs in the joined `text`: default `"\n\n"`.
   * `"none"` joins them with nothing in between.
   */
  separator?: string;
  /**
   * Drops a record's output when this holds. Either a function of the record
   * (and its prompt values), or a condition written like the inside of a
   * section tag: `void`, `!email`, `status=cancelled`, `amount<10`. The
   * condition is evaluated against the record's prompt values (mapped
   * variables and raw field names); a name that is neither is matched to a
   * field like a variable (`status` → `Status`).
   */
  skipIf?:
    | string
    | ((record: MergeRecord, values: PromptValues, index: number) => boolean);
  /** Stop after this many outputs (default `MAX_MERGE_OUTPUTS`). */
  maxOutputs?: number;
  /** Stop once the outputs reach this many characters (default `MAX_MERGE_LENGTH`). */
  maxLength?: number;
  /** First record to merge, 1-based (default 1). */
  from?: number;
  /** Last record to merge, 1-based and inclusive (default: the last). */
  to?: number;
  /** See `recordToValues` (default `true`: blank cells use defaults). */
  blankAsMissing?: boolean;
  /** Options for parsing `source` when it is not already parsed. */
  parse?: ParseDataSourceOptions;
}

export interface MergeOutput {
  /** 0-based index of the record in the data source. */
  index: number;
  record: MergeRecord;
  /** The values the prompt was resolved with. */
  values: PromptValues;
  text: string;
  map: SourceMapSegment[];
}

export interface MergeSkip {
  index: number;
  record: MergeRecord;
  reason: "skip-if";
}

export type MergeDiagnosticCode =
  | PromptDiagnostic["code"]
  | "unmapped-variable"
  | "invalid-skip-condition"
  | "max-outputs"
  | "max-length"
  | "data-source";

/** A grammar diagnostic from the template, or a merge-level problem. */
export interface MergeDiagnostic {
  code: MergeDiagnosticCode;
  message: string;
  /** Variable, for grammar and `unmapped-variable` diagnostics. */
  name?: string;
  start?: number;
  end?: number;
  templateName?: string;
}

export interface MergeRecordsResult {
  outputs: MergeOutput[];
  skipped: MergeSkip[];
  diagnostics: MergeDiagnostic[];
  /** Every output's text joined with the separator. */
  text: string;
  /** The variable → field mapping used. */
  mapping: Record<string, string | null>;
  /** The merge stopped early at `maxOutputs` or `maxLength`. */
  truncated: boolean;
}

function isParsedSource(source: unknown): source is MergeDataSource {
  return (
    !!source &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    Array.isArray((source as MergeDataSource).fields) &&
    Array.isArray((source as MergeDataSource).records)
  );
}

/**
 * Merges a prompt with every record of a data source: one resolved output per
 * record, in order. Fields are matched to the prompt's variables
 * automatically (override with `mapping`), blank cells fall back to the
 * variable's default, `{?field}` / `{?field>3}` sections are evaluated per
 * record, and `skipIf` drops records. Grammar diagnostics in the prompt are
 * reported once. Never throws.
 */
export function mergeRecords(
  template: string,
  source: MergeDataSource | DataSourceInput,
  options: MergeRecordsOptions = {},
): MergeRecordsResult {
  const data = isParsedSource(source)
    ? source
    : parseDataSource(source, options.parse);
  const diagnostics: MergeDiagnostic[] = [];
  if (!isParsedSource(source)) {
    for (const warning of data.warnings) {
      if (warning.code === "empty") continue;
      diagnostics.push({ code: "data-source", message: warning.message });
    }
  }

  const variables = extractVariables(template, {
    templates: options.templates,
    bindings: options.bindings,
    maxDepth: options.maxDepth,
  });
  const auto = matchFields(variables, data.fields).mapping;
  const mapping: Record<string, string | null> = { ...auto };
  for (const [variable, field] of Object.entries(options.mapping ?? {})) {
    Object.defineProperty(mapping, variable, {
      value: field,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const variable of variables) {
    const field = mapping[variable.name];
    if (
      (field === null || field === undefined) &&
      variable.defaultValue === undefined &&
      variable.usedAsValue
    ) {
      diagnostics.push({
        code: "unmapped-variable",
        message: `No field is mapped to "${variable.name}", so it stays as a placeholder`,
        name: variable.name,
      });
    }
  }

  let skip: ((record: MergeRecord, values: PromptValues, index: number) => boolean) | undefined;
  if (typeof options.skipIf === "function") {
    skip = options.skipIf;
  } else if (typeof options.skipIf === "string" && options.skipIf.trim()) {
    const parsed = parseConditionExpression(options.skipIf);
    if ("error" in parsed) {
      diagnostics.push({
        code: "invalid-skip-condition",
        message: `Invalid skipIf condition "${options.skipIf}": ${parsed.error}`,
      });
    } else {
      // The condition may name a field the template never uses: match it to
      // a field the same way variables are (`status` → `Status`).
      const field =
        mapping[parsed.name] ??
        matchFields([parsed.name], data.fields).mapping[parsed.name];
      skip = (record, values) => {
        if (
          field &&
          !Object.prototype.hasOwnProperty.call(values, parsed.name) &&
          Object.prototype.hasOwnProperty.call(record, field)
        ) {
          return evaluateConditionExpression(parsed, {
            ...values,
            [parsed.name]: record[field],
          });
        }
        return evaluateConditionExpression(parsed, values);
      };
    }
  }

  const separator =
    options.separator === undefined
      ? "\n\n"
      : options.separator === "none"
        ? ""
        : options.separator;
  const maxOutputs = Math.max(0, options.maxOutputs ?? MAX_MERGE_OUTPUTS);
  const maxLength = Math.max(0, options.maxLength ?? MAX_MERGE_LENGTH);
  const first = Math.max(1, Math.floor(options.from ?? 1)) - 1;
  const last = Math.min(
    data.records.length,
    Math.floor(options.to ?? data.records.length),
  );

  const outputs: MergeOutput[] = [];
  const skipped: MergeSkip[] = [];
  let length = 0;
  let truncated = false;
  let reportedGrammar = false;

  for (let index = first; index < last; index++) {
    const record = data.records[index];
    const values = recordToValues(record, mapping, {
      blankAsMissing: options.blankAsMissing,
    });
    if (skip?.(record, values, index)) {
      skipped.push({ index, record, reason: "skip-if" });
      continue;
    }
    if (outputs.length >= maxOutputs) {
      truncated = true;
      diagnostics.push({
        code: "max-outputs",
        message: `Stopped after ${maxOutputs} outputs`,
      });
      break;
    }
    const resolved = resolvePrompt(template, options.templates, {
      bindings: options.bindings,
      maxDepth: options.maxDepth,
      values,
    });
    if (!reportedGrammar) {
      // The template's grammar diagnostics are the same for every record.
      reportedGrammar = true;
      diagnostics.push(...resolved.diagnostics);
    }
    const added = resolved.text.length + (outputs.length > 0 ? separator.length : 0);
    if (length + added > maxLength) {
      truncated = true;
      diagnostics.push({
        code: "max-length",
        message: `Stopped at ${outputs.length} outputs: the merged text would exceed ${maxLength} characters`,
      });
      break;
    }
    length += added;
    outputs.push({ index, record, values, text: resolved.text, map: resolved.map });
  }

  return {
    outputs,
    skipped,
    diagnostics,
    text: outputs.map((output) => output.text).join(separator),
    mapping,
    truncated,
  };
}

/**
 * Serializes merge outputs for copying or download: `"text"` joins them with
 * `separator` (default `"\n\n"`), `"json"` writes an array of
 * `{ record, text }` objects (`record` is 1-based).
 */
export function serializeMergeOutputs(
  outputs: ReadonlyArray<Pick<MergeOutput, "index" | "text" | "values">>,
  format: "text" | "json" = "text",
  separator = "\n\n",
): string {
  if (format === "json") {
    return JSON.stringify(
      outputs.map((output) => ({ record: output.index + 1, text: output.text })),
      null,
      2,
    );
  }
  return outputs.map((output) => output.text).join(separator === "none" ? "" : separator);
}
