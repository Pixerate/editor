// Portions ported from wordcraft/crates/engine/src/cmd/mailings.rs and
// wordcraft/crates/formats/src/sheet.rs (MIT OR Apache-2.0, © ArtCraft Team
// and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Mail-merge data sources: CSV / TSV text, JSON, rows or objects normalised
 * into named fields and string records, plus fuzzy matching of prompt
 * variables to those fields.
 *
 * Imports only the self-contained CSV module, never the spreadsheet entry, so
 * the grammar entry stays light.
 */
import { parseCsv } from "../spreadsheet/csv";
import type { PromptValues } from "./tokens";

/** Most records a data source keeps by default. */
export const MAX_DATA_SOURCE_RECORDS = 100_000;
/** Most fields a data source keeps by default. */
export const MAX_DATA_SOURCE_FIELDS = 1_000;

/** One record: field name → cell text. */
export type MergeRecord = Record<string, string>;

/** Anything `parseDataSource` accepts. */
export type DataSourceInput =
  | string
  | ReadonlyArray<ReadonlyArray<unknown>>
  | ReadonlyArray<Readonly<Record<string, unknown>>>;

export interface ParseDataSourceOptions {
  /**
   * Field separator for delimited text. `"auto"` (the default) picks whichever
   * of `,` `;` and tab occurs most often in the first line (outside quotes),
   * preferring `,` on a tie.
   */
  delimiter?: "auto" | string;
  /**
   * Whether the first row names the fields (default `true`). Without a header
   * the fields are `Column 1`…`Column N`. Ignored for arrays of objects.
   */
  hasHeader?: boolean;
  /**
   * How to read a string: `"auto"` (default) parses text starting with `[` as
   * JSON and falls back to delimited text when that fails.
   */
  format?: "auto" | "csv" | "json";
  /** Record cap (default `MAX_DATA_SOURCE_RECORDS`). */
  maxRecords?: number;
  /** Field cap (default `MAX_DATA_SOURCE_FIELDS`). */
  maxFields?: number;
}

export type DataSourceWarningCode =
  | "empty"
  | "invalid-json"
  | "unsupported-json"
  | "blank-header"
  | "duplicate-header"
  | "ragged-rows"
  | "records-truncated"
  | "fields-truncated";

export interface DataSourceWarning {
  code: DataSourceWarningCode;
  message: string;
  /** For `ragged-rows`: how many records were padded or cut. */
  count?: number;
}

export interface MergeDataSource {
  /** Field names: trimmed, unique (case-insensitively), never blank. */
  fields: string[];
  /** One entry per record, with every field present. */
  records: MergeRecord[];
  warnings: DataSourceWarning[];
  /** How the input was read. */
  format: "csv" | "json" | "rows" | "objects";
  /** The delimiter used for delimited text. */
  delimiter?: string;
}

const AUTO_DELIMITERS = [",", ";", "\t"];

/** Counts the auto-detect candidates in the first line, ignoring quoted text. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(AUTO_DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "\n" || ch === "\r") break;
    if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const d of AUTO_DELIMITERS) {
    if (counts.get(d)! > counts.get(best)!) best = d;
  }
  return best;
}

/**
 * Field names from a header row: names are trimmed, a blank name becomes
 * `Column N` (its 1-based position), and repeats (compared case-insensitively)
 * are numbered `Name 2`, `Name 3`, ….
 */
export function normalizeFieldNames(row: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  const taken = new Set<string>();
  row.forEach((cell, i) => {
    const trimmed = cellText(cell).trim();
    const base = trimmed === "" ? `Column ${i + 1}` : trimmed;
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} ${k}`;
    taken.add(name.toLowerCase());
    out.push(name);
  });
  return out;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Sets an own property, even for names such as `__proto__`. */
function setField(record: MergeRecord, name: string, value: string): void {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isBlankRow(row: ReadonlyArray<unknown>): boolean {
  return row.every((cell) => cellText(cell).trim() === "");
}

/**
 * Reads a mail-merge data source.
 *
 * - **Text**: CSV / TSV (RFC 4180 quoting, doubled quotes, CRLF / LF / CR,
 *   a leading BOM ignored) with the delimiter auto-detected, or JSON (an
 *   array of objects or of arrays).
 * - **Rows** (`unknown[][]`): the first row is the header unless
 *   `hasHeader: false`.
 * - **Objects**: the fields are the union of keys in first-seen order.
 *
 * Blank rows are skipped, header names are normalised (`normalizeFieldNames`),
 * records are padded or cut to the header width, and records and fields are
 * capped. Cells become strings (`null` → `""`, nested values → JSON). Problems
 * are reported in `warnings`; this never throws.
 */
export function parseDataSource(
  input: DataSourceInput,
  options: ParseDataSourceOptions = {},
): MergeDataSource {
  const warnings: DataSourceWarning[] = [];
  if (typeof input === "string") {
    const format = options.format ?? "auto";
    const trimmed = input.trim();
    if (format === "json" || (format === "auto" && /^\[/.test(trimmed))) {
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        ok = false;
        if (format === "json") {
          warnings.push({
            code: "invalid-json",
            message: `Invalid JSON: ${(error as Error).message}`,
          });
          return { fields: [], records: [], warnings, format: "json" };
        }
      }
      if (ok) {
        if (!Array.isArray(parsed)) {
          warnings.push({
            code: "unsupported-json",
            message: "JSON data must be an array of objects or of arrays",
          });
          return { fields: [], records: [], warnings, format: "json" };
        }
        const result = fromArray(parsed, options, warnings);
        return { ...result, format: "json" };
      }
    }
    const delimiter =
      !options.delimiter || options.delimiter === "auto"
        ? detectDelimiter(input)
        : options.delimiter;
    let rows: string[][];
    try {
      rows = parseCsv(input, { delimiter });
    } catch (error) {
      warnings.push({ code: "empty", message: (error as Error).message });
      return { fields: [], records: [], warnings, format: "csv", delimiter };
    }
    return {
      ...fromRows(rows, options, warnings),
      format: "csv",
      delimiter,
    };
  }
  const result = fromArray(input as ReadonlyArray<unknown>, options, warnings);
  return {
    ...result,
    format: result.objects ? "objects" : "rows",
  };
}

function fromArray(
  items: ReadonlyArray<unknown>,
  options: ParseDataSourceOptions,
  warnings: DataSourceWarning[],
): { fields: string[]; records: MergeRecord[]; warnings: DataSourceWarning[]; objects: boolean } {
  const objects = items.some(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  if (!objects) {
    const rows = items.filter((item): item is unknown[] => Array.isArray(item));
    return { ...fromRows(rows, options, warnings), objects: false };
  }
  const maxFields = options.maxFields ?? MAX_DATA_SOURCE_FIELDS;
  const maxRecords = options.maxRecords ?? MAX_DATA_SOURCE_RECORDS;
  const fields: string[] = [];
  const seen = new Set<string>();
  let fieldsTruncated = false;
  const rows = items.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      if (fields.length >= maxFields) {
        fieldsTruncated = true;
        continue;
      }
      seen.add(key);
      fields.push(key);
    }
  }
  if (fieldsTruncated) {
    warnings.push({
      code: "fields-truncated",
      message: `Only the first ${maxFields} fields were kept`,
    });
  }
  const records: MergeRecord[] = [];
  for (const row of rows) {
    if (fields.every((field) => cellText(row[field]).trim() === "")) continue;
    if (records.length >= maxRecords) {
      warnings.push({
        code: "records-truncated",
        message: `Only the first ${maxRecords} records were kept`,
      });
      break;
    }
    const record: MergeRecord = {};
    for (const field of fields) {
      const value = Object.prototype.hasOwnProperty.call(row, field)
        ? row[field]
        : undefined;
      setField(record, field, cellText(value));
    }
    records.push(record);
  }
  if (records.length === 0) {
    warnings.push({ code: "empty", message: "The data source has no records" });
  }
  return { fields, records, warnings, objects: true };
}

function fromRows(
  allRows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: ParseDataSourceOptions,
  warnings: DataSourceWarning[],
): { fields: string[]; records: MergeRecord[]; warnings: DataSourceWarning[] } {
  const maxFields = options.maxFields ?? MAX_DATA_SOURCE_FIELDS;
  const maxRecords = options.maxRecords ?? MAX_DATA_SOURCE_RECORDS;
  const rows = allRows.filter((row) => !isBlankRow(row));
  if (rows.length === 0) {
    warnings.push({ code: "empty", message: "The data source has no records" });
    return { fields: [], records: [], warnings };
  }
  const hasHeader = options.hasHeader ?? true;
  let fields: string[];
  let body: ReadonlyArray<ReadonlyArray<unknown>>;
  let widest: number;
  if (hasHeader) {
    const header = rows[0];
    widest = header.length;
    if (header.some((cell) => cellText(cell).trim() === "")) {
      warnings.push({
        code: "blank-header",
        message: "Blank column headers were named \"Column N\"",
      });
    }
    fields = normalizeFieldNames(header.slice(0, maxFields));
    const lower = header.map((cell) => cellText(cell).trim().toLowerCase());
    if (lower.some((name, i) => name !== "" && lower.indexOf(name) !== i)) {
      warnings.push({
        code: "duplicate-header",
        message: "Repeated column headers were numbered",
      });
    }
    body = rows.slice(1);
  } else {
    widest = Math.max(...rows.map((row) => row.length));
    fields = Array.from(
      { length: Math.min(widest, maxFields) },
      (_, i) => `Column ${i + 1}`,
    );
    body = rows;
  }
  if (widest > maxFields) {
    warnings.push({
      code: "fields-truncated",
      message: `Only the first ${maxFields} fields were kept`,
    });
  }
  if (body.length > maxRecords) {
    warnings.push({
      code: "records-truncated",
      message: `Only the first ${maxRecords} of ${body.length} records were kept`,
    });
    body = body.slice(0, maxRecords);
  }
  let ragged = 0;
  const records = body.map((row) => {
    if (hasHeader && row.length !== widest) ragged++;
    const record: MergeRecord = {};
    fields.forEach((field, i) => setField(record, field, cellText(row[i])));
    return record;
  });
  if (ragged > 0) {
    warnings.push({
      code: "ragged-rows",
      message: `${ragged} record${ragged === 1 ? " was" : "s were"} padded or cut to ${widest} fields`,
      count: ragged,
    });
  }
  if (records.length === 0) {
    warnings.push({ code: "empty", message: "The data source has no records" });
  }
  return { fields, records, warnings };
}

/** Lower-cases and drops spaces, `_`, `-` and `.` so `First Name` matches `first_name`. */
export function normalizeFieldKey(name: string): string {
  return name.toLowerCase().replace(/[\s_.\-]+/g, "");
}

/**
 * Built-in alias groups for `matchFields`: any name in a group matches any
 * other (after `normalizeFieldKey`). Extended from Word's address-block
 * field detection.
 */
export const FIELD_ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ["FirstName", "First", "GivenName", "Forename", "FName"],
  ["LastName", "Last", "Surname", "FamilyName", "LName"],
  ["Name", "FullName", "DisplayName"],
  ["Company", "CompanyName", "Organization", "Organisation", "Employer", "Business"],
  ["Address", "AddressLine1", "Address1", "Street", "StreetAddress"],
  ["City", "Town"],
  ["State", "Province", "Region", "County"],
  ["PostalCode", "ZIP", "ZipCode", "Postcode"],
  ["Country", "CountryName", "Nation"],
  ["Title", "CourtesyTitle", "Salutation", "Honorific"],
  ["Email", "EmailAddress", "Mail", "EMail"],
  ["Phone", "PhoneNumber", "Telephone", "Tel", "Mobile"],
];

export type FieldMatchKind = "exact" | "normalized" | "alias";

export interface FieldMatch {
  variable: string;
  /** The matched field, or `null`. */
  field: string | null;
  kind: FieldMatchKind | null;
}

export interface FieldMapping {
  /** Variable → field (or `null` when unmatched), in variable order. */
  mapping: Record<string, string | null>;
  matches: FieldMatch[];
  unmatchedVariables: string[];
  /** Fields no variable maps to. */
  unusedFields: string[];
}

export interface MatchFieldsOptions {
  /** Extra alias groups, checked after the built-in ones. */
  aliases?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Maps prompt variables to data source fields: an exact name first, then a
 * case-, space- and punctuation-insensitive match (`first_name` ↔
 * `First Name`), then an alias (`FirstName` ↔ `First` / `GivenName`, see
 * `FIELD_ALIASES`). Several variables may map to the same field.
 */
export function matchFields(
  variables: ReadonlyArray<string | { name: string }>,
  fields: ReadonlyArray<string>,
  options: MatchFieldsOptions = {},
): FieldMapping {
  const names = Array.from(
    new Set(variables.map((v) => (typeof v === "string" ? v : v.name))),
  );
  const byKey = new Map<string, string>();
  for (const field of fields) {
    const key = normalizeFieldKey(field);
    if (!byKey.has(key)) byKey.set(key, field);
  }
  const groups = [...FIELD_ALIASES, ...(options.aliases ?? [])].map((group) =>
    group.map(normalizeFieldKey),
  );

  const matches: FieldMatch[] = names.map((variable) => {
    if (fields.includes(variable)) {
      return { variable, field: variable, kind: "exact" };
    }
    const key = normalizeFieldKey(variable);
    const normalized = byKey.get(key);
    if (normalized !== undefined) {
      return { variable, field: normalized, kind: "normalized" };
    }
    for (const group of groups) {
      if (!group.includes(key)) continue;
      for (const alias of group) {
        const field = byKey.get(alias);
        if (field !== undefined) return { variable, field, kind: "alias" };
      }
    }
    return { variable, field: null, kind: null };
  });

  const mapping: Record<string, string | null> = {};
  for (const match of matches) {
    Object.defineProperty(mapping, match.variable, {
      value: match.field,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const used = new Set(matches.map((m) => m.field));
  return {
    mapping,
    matches,
    unmatchedVariables: matches.filter((m) => !m.field).map((m) => m.variable),
    unusedFields: fields.filter((field) => !used.has(field)),
  };
}

export interface RecordToValuesOptions {
  /**
   * Treat blank cells as missing so `{name|default}` falls back to its
   * default (default `true`). With `false`, a blank cell renders as empty.
   */
  blankAsMissing?: boolean;
}

/**
 * The prompt values for one record: every field under its own name, then
 * each mapped variable set from its field (a `null` mapping leaves the
 * variable unset even if a field shares its name).
 */
export function recordToValues(
  record: MergeRecord,
  mapping: Readonly<Record<string, string | null | undefined>> = {},
  options: RecordToValuesOptions = {},
): PromptValues {
  const blankAsMissing = options.blankAsMissing ?? true;
  const values: PromptValues = {};
  const assign = (name: string, value: string | undefined) => {
    if (value === undefined || (blankAsMissing && value.trim() === "")) {
      delete values[name];
      return;
    }
    Object.defineProperty(values, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  const own = (name: string) =>
    Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
  for (const field of Object.keys(record)) assign(field, record[field]);
  for (const variable of Object.keys(mapping)) {
    const field = mapping[variable];
    if (field === undefined) continue;
    assign(variable, field === null ? undefined : own(field));
  }
  return values;
}
