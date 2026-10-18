import type { FieldSpec } from "./types.js";

/** A field as agents and hosts see it: what can be written and how. */
export interface FieldDescription {
  key: string;
  label: string;
  type: FieldSpec["type"];
  options?: string[];
  min?: number;
  max?: number;
  hint?: string;
  /** Only on nodes of these shapes. */
  shapes?: string[];
}

/** {@link FieldSpec}s without the inspector-only details (placeholders, steps, option labels). */
export function describeFields(fields: readonly FieldSpec[] | undefined): FieldDescription[] {
  return (fields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.options ? { options: f.options.map((o) => o.value) } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.hint ? { hint: f.hint } : {}),
    ...(f.shapes ? { shapes: f.shapes } : {}),
  }));
}

/** The values of `data` that `fields` declare (what a reader needs, without parser internals). */
export function pickFieldData(
  fields: readonly FieldSpec[] | undefined,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    const value = data?.[f.key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && !value.length)) out[f.key] = value;
  }
  return out;
}

const list = (items: readonly string[]) => items.map((s) => `"${s}"`).join(", ");

/**
 * Checks a data patch against a family's fields and returns it as the adapters expect it
 * (`null` or `""` clears a field, so it becomes `undefined`). Throws a sentence naming the
 * problem and the allowed values when a key is unknown, does not apply to `shape`, or a
 * value has the wrong type or is out of range. Nothing is changed when it throws.
 *
 * Value types: `text` and `select` take a string, `number` a number, `boolean` a boolean,
 * `numbers` an array of numbers, `lines` and `tags` an array of strings.
 */
export function checkFieldData(
  fields: readonly FieldSpec[] | undefined,
  data: Record<string, unknown>,
  what: string,
  shape?: string,
): Record<string, unknown> {
  const all = fields ?? [];
  const usable = all.filter((f) => !f.shapes || shape === undefined || f.shapes.includes(shape));
  if (!all.length) throw new Error(`${what} has no data fields to set.`);
  const keys = Object.keys(data);
  if (!keys.length) throw new Error(`Give at least one field to set; ${what} has ${list(usable.map((f) => f.key))}.`);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = all.find((f) => f.key === key);
    if (!field) throw new Error(`Unknown field "${key}" for ${what}; use one of ${list(usable.map((f) => f.key))}.`);
    if (!usable.includes(field))
      throw new Error(`Field "${key}" only applies to ${list(field.shapes!)} nodes, not "${shape}".`);
    const value = data[key];
    if (value === null || value === "") {
      out[key] = undefined;
      continue;
    }
    const bad = (expected: string) => new Error(`Field "${key}" (${field.label}) takes ${expected}; got ${JSON.stringify(value)}.`);
    switch (field.type) {
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) throw bad("a number");
        if (field.min !== undefined && value < field.min) throw bad(`a number of at least ${field.min}`);
        if (field.max !== undefined && value > field.max) throw bad(`a number of at most ${field.max}`);
        break;
      }
      case "numbers":
        if (!Array.isArray(value) || !value.every((n) => typeof n === "number" && Number.isFinite(n))) throw bad("an array of numbers");
        break;
      case "lines":
      case "tags":
        if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) throw bad("an array of strings");
        break;
      case "boolean":
        if (typeof value !== "boolean") throw bad("true or false");
        break;
      case "select": {
        const options = (field.options ?? []).map((o) => o.value);
        if (typeof value !== "string" || (options.length && !options.includes(value))) throw bad(`one of ${list(options)}`);
        break;
      }
      default:
        if (typeof value !== "string") throw bad("a string");
    }
    out[key] = value;
  }
  return out;
}
