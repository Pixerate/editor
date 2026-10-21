// Portions ported from craft-libs-main/crates/settings/src/migrate.rs, src/document.rs and
// src/error.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import { isUnsafeJsonKey, stripPrototypeKeys } from "../tools/safe-json";

/** A section whose stored value did not fit; its defaults were used instead. */
export interface SectionProblem {
  /** Top-level key of the section. */
  section: string;
  message: string;
}

/** Why a loaded document must not be written back. */
export type ReadOnlyReason =
  | { kind: "newerVersion"; version: number; supported: number; message: string }
  | { kind: "migrationFailed"; from: number; message: string }
  | { kind: "invalid"; message: string };

/** What happened while loading a document. Nothing in here is fatal. */
export interface LoadReport {
  /** Set when the document was upgraded step by step from this older version. */
  migratedFrom: number | null;
  /** The version found in the input (`null` when it had none). */
  version: number | null;
  /** Sections replaced by their defaults (see `loadSections`). */
  problems: SectionProblem[];
  /**
   * Set when the document must not be saved over: written by a newer build,
   * a migration step failed, or the input was not an object. Show the values,
   * but never overwrite the stored document.
   */
  readOnly: ReadOnlyReason | null;
  /** Top-level keys this build does not know; kept in `unknown` so a save can write them back. */
  unknownKeys: string[];
}

/** True when something should be shown to the user. */
export function hasLoadProblems(report: LoadReport): boolean {
  return report.problems.length > 0 || report.readOnly !== null;
}

export function createLoadReport(partial: Partial<LoadReport> = {}): LoadReport {
  return {
    migratedFrom: null,
    version: null,
    problems: [],
    readOnly: null,
    unknownKeys: [],
    ...partial,
  };
}

export type JsonObject = Record<string, unknown>;

/** One migration step: turns a document at version `from` into version `from + 1`. */
export type MigrationStep = (doc: JsonObject) => JsonObject | void;

export interface MigrateOptions {
  /** The version this build writes. */
  currentVersion: number;
  /** Steps keyed by the version they start from. */
  steps?: Record<number, MigrationStep>;
  /** Key holding the version (default `"version"`). */
  versionKey?: string;
  /**
   * Version assumed when the key is missing (default: `currentVersion`, i.e. a
   * hand-written document is taken as current and the key is added).
   */
  missingVersion?: number;
}

export interface MigrateResult {
  /** The migrated document (a deep copy; the input is never modified). */
  doc: JsonObject;
  report: LoadReport;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepClone = <T>(value: T): T =>
  typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);

/** Parses a JSON string, or deep-copies an object. `undefined` when it is not an object. */
function toObject(json: unknown): JsonObject | undefined {
  let value = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      return undefined;
    }
  }
  return isObject(value) ? stripPrototypeKeys(deepClone(value)) : undefined;
}

/**
 * Brings a stored document up to `currentVersion` by running one step per
 * version (`steps[v]` turns version `v` into `v + 1`).
 *
 * - Missing version: taken as `missingVersion` (default current); the key is added.
 * - Newer than `currentVersion`: left alone and reported `readOnly` (never overwrite
 *   a file written by a newer build).
 * - A missing or throwing step: the document is returned as it was before
 *   migrating and reported `readOnly`.
 * - Keys the steps do not touch are preserved.
 */
export function migrateDocument(json: unknown, options: MigrateOptions): MigrateResult {
  const versionKey = options.versionKey ?? "version";
  const target = options.currentVersion;
  const original = toObject(json);
  if (!original) {
    return {
      doc: { [versionKey]: target },
      report: createLoadReport({
        readOnly: { kind: "invalid", message: "document is not a JSON object" },
      }),
    };
  }
  const raw = original[versionKey];
  const found = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
  const from = found ?? options.missingVersion ?? target;
  const report = createLoadReport({ version: found });

  if (from > target) {
    report.readOnly = {
      kind: "newerVersion",
      version: from,
      supported: target,
      message: `document has version ${from}, newer than the supported ${target}`,
    };
    return { doc: original, report };
  }
  if (from === target) {
    original[versionKey] = target;
    return { doc: original, report };
  }

  let doc = deepClone(original);
  for (let step = from; step < target; step++) {
    const fn = options.steps?.[step];
    if (!fn) {
      report.readOnly = {
        kind: "migrationFailed",
        from: step,
        message: `no migration step from version ${step}`,
      };
      return { doc: original, report };
    }
    try {
      doc = fn(doc) ?? doc;
    } catch (error) {
      report.readOnly = {
        kind: "migrationFailed",
        from: step,
        message: `migration from version ${step} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      // Never hand back half-migrated values.
      return { doc: original, report };
    }
    doc[versionKey] = step + 1;
  }
  report.migratedFrom = from;
  return { doc, report };
}

/** How one top-level section is read. */
export interface SectionSpec<V> {
  /** Validates / converts the stored value; throw (or return `undefined`) to reject it. */
  parse: (value: unknown) => V | undefined;
  /** Used when the section is missing or rejected. */
  defaults: V | (() => V);
}

export type SectionSpecs<T> = { [K in keyof T]: SectionSpec<T[K]> };

export interface LoadSectionsOptions {
  /** Keys that are neither sections nor unknown (default `["version"]`). */
  ignore?: string[];
}

export interface LoadSectionsResult<T> {
  value: T;
  /** Sections that were present but rejected (missing ones are not problems). */
  problems: SectionProblem[];
  /** Top-level keys not described by `sections`; write them back to keep them. */
  unknown: JsonObject;
}

/**
 * Reads `doc` one top-level section at a time: a section that does not parse
 * is reported and replaced by its defaults, every other section is kept. This
 * keeps one bad value (e.g. a renamed enum) from resetting the whole document.
 */
export function loadSections<T>(
  doc: unknown,
  sections: SectionSpecs<T>,
  options: LoadSectionsOptions = {},
): LoadSectionsResult<T> {
  const source = isObject(doc) ? doc : {};
  const ignore = new Set(options.ignore ?? ["version"]);
  const value = {} as T;
  const problems: SectionProblem[] = [];
  for (const key of Object.keys(sections) as (keyof T & string)[]) {
    const spec = sections[key];
    const fallback = () =>
      typeof spec.defaults === "function"
        ? (spec.defaults as () => T[typeof key])()
        : spec.defaults;
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      value[key] = fallback();
      continue;
    }
    try {
      const parsed = spec.parse(source[key]);
      if (parsed === undefined) throw new Error("invalid value");
      value[key] = parsed;
    } catch (error) {
      problems.push({
        section: key,
        message: error instanceof Error ? error.message : String(error),
      });
      value[key] = fallback();
    }
  }
  const unknown: JsonObject = {};
  for (const key of Object.keys(source)) {
    if (!(key in sections) && !ignore.has(key) && !isUnsafeJsonKey(key)) unknown[key] = source[key];
  }
  return { value, problems, unknown };
}

export interface LoadDocumentOptions extends MigrateOptions, LoadSectionsOptions {}

export interface LoadDocumentResult<T> extends LoadSectionsResult<T> {
  report: LoadReport;
}

/**
 * `migrateDocument` followed by `loadSections`, with one `LoadReport`
 * (`problems` and `unknownKeys` filled in).
 */
export function loadDocument<T>(
  json: unknown,
  sections: SectionSpecs<T>,
  options: LoadDocumentOptions,
): LoadDocumentResult<T> {
  const { doc, report } = migrateDocument(json, options);
  const ignore = options.ignore ?? [options.versionKey ?? "version"];
  const result = loadSections(report.readOnly?.kind === "invalid" ? {} : doc, sections, {
    ignore,
  });
  report.problems = result.problems;
  report.unknownKeys = Object.keys(result.unknown);
  return { ...result, report };
}
