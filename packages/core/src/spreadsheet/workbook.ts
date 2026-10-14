// Portions ported from gridcraft/crates/model/src/workbook.rs and
// gridcraft/crates/engine/src/cmd/formulas.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Workbook rules shared by the controller and the framework bindings: sheet
 * and defined-name validation, and default sheet names.
 */
import type { SpreadsheetDefinedName } from './types';

/** Longest sheet name Excel accepts. */
export const MAX_SHEET_NAME_LENGTH = 31;
/** Longest defined name Excel accepts. */
export const MAX_DEFINED_NAME_LENGTH = 255;

const sameName = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/**
 * Checks a sheet name like Excel: 1–31 characters, none of `: \ / ? * [ ]`,
 * not starting or ending with `'`, not the reserved `History`, and not used
 * by another sheet (case-insensitively). Returns why it is invalid, or null.
 */
export function validateSheetName(name: string, existingNames: readonly string[] = []): string | null {
  const length = Array.from(name).length;
  if (length === 0 || name.trim() === '') return "A sheet name can't be blank.";
  if (length > MAX_SHEET_NAME_LENGTH) return `A sheet name can't be longer than ${MAX_SHEET_NAME_LENGTH} characters.`;
  if (/[:\\/?*[\]]/.test(name)) return "A sheet name can't contain any of these characters: : \\ / ? * [ ]";
  if (name.startsWith("'") || name.endsWith("'")) return "A sheet name can't begin or end with an apostrophe.";
  if (sameName(name, 'History')) return '"History" is a reserved name.';
  if (existingNames.some((existing) => sameName(existing, name))) return 'That name is already taken. Try a different one.';
  return null;
}

/** The first `Sheet N` not used by `existingNames`. */
export function nextSheetName(existingNames: readonly string[], base = 'Sheet'): string {
  for (let n = 1; ; n++) {
    const candidate = `${base} ${n}`;
    if (!existingNames.some((existing) => sameName(existing, candidate))) return candidate;
  }
}

/**
 * A name for a copy of the sheet `name`: `Name (2)`, `Name (3)`, …, shortened
 * so the suffix fits in 31 characters.
 */
export function copySheetName(name: string, existingNames: readonly string[]): string {
  for (let k = 2; ; k++) {
    const suffix = ` (${k})`;
    const keep = Math.max(0, MAX_SHEET_NAME_LENGTH - suffix.length);
    const candidate = `${Array.from(name).slice(0, keep).join('').trimEnd()}${suffix}`;
    if (!existingNames.some((existing) => sameName(existing, candidate))) return candidate;
  }
}

/** Looks like an R1C1 reference (`R`, `C`, `RC`, `R2`, `C3`, `R1C1`), which Excel refuses as a name. */
function isR1C1Like(name: string): boolean {
  let i = 0;
  if (/[Rr]/.test(name[i] ?? '')) {
    i++;
    while (i < name.length && /\d/.test(name[i])) i++;
  }
  if (/[Cc]/.test(name[i] ?? '')) {
    i++;
    while (i < name.length && /\d/.test(name[i])) i++;
  }
  return name.length > 0 && i === name.length;
}

/**
 * Checks a defined name like Excel: starts with a letter, `_` or `\`;
 * continues with letters, digits, `_`, `.`, `\` or `?`; at most 255
 * characters; and must not look like a cell reference (`A1`, `TAX2024`), an
 * R1C1 reference (`R1C1`, `R`, `C3`) or a boolean. Returns why it is invalid,
 * or null.
 */
export function validateDefinedName(name: string): string | null {
  if (name === '') return "A name can't be blank.";
  if (Array.from(name).length > MAX_DEFINED_NAME_LENGTH) return `A name can't be longer than ${MAX_DEFINED_NAME_LENGTH} characters.`;
  if (!/^[\p{L}_\\][\p{L}\p{N}_.\\?]*$/u.test(name)) {
    return /^[\p{L}_\\]/u.test(name)
      ? 'A name can only contain letters, numbers, periods, underscores, backslashes and question marks.'
      : 'A name must start with a letter, an underscore or a backslash.';
  }
  if (/^\$?[A-Za-z]+\$?\d+$/.test(name)) return "A name can't look like a cell reference (such as A1).";
  if (isR1C1Like(name)) return "A name can't look like an R1C1 reference (such as R1C1, R or C).";
  if (sameName(name, 'TRUE') || sameName(name, 'FALSE')) return "A name can't be TRUE or FALSE.";
  return null;
}

/** Whether a defined name holds a LAMBDA (and so is called like a function). */
export function isLambdaDefinition(definition: Pick<SpreadsheetDefinedName, 'refersTo'>): boolean {
  return /^=?\s*LAMBDA\s*\(/i.test(definition.refersTo);
}
