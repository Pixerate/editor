// Portions ported from wordcraft/crates/engine/src/cmd/mailings.rs (MIT OR
// Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type {
  ComparisonOperator,
  ConditionComparison,
  ConditionalKind,
  PromptValue,
  PromptValues,
} from "./tokens";

/** Result of classifying the text between the braces of a `{…}` token. */
export type ParsedVariableBody =
  | {
      kind: "variable";
      name: string;
      defaultValue?: string;
      description?: string;
    }
  | {
      kind: "conditional";
      conditional: ConditionalKind;
      name: string;
    };

const CONDITIONAL_PREFIXES: Record<string, ConditionalKind> = {
  "?": "if",
  "!": "unless",
  "/": "end",
};

/**
 * Removes grammar escapes: `\|`, `\{`, `\}` and `\\` become the bare character.
 * Any other backslash is kept, so Windows paths and regex-like text survive.
 */
export function unescapeVariableText(text: string): string {
  return text.replace(/\\([\\{}|])/g, "$1");
}

/**
 * Escapes text so it can be embedded as a variable default or description.
 */
export function escapeVariableText(text: string): string {
  return text.replace(/[\\{}|]/g, (ch) => `\\${ch}`);
}

/** Splits on `|` characters that are not escaped with a backslash. */
function splitUnescapedPipes(body: string, limit: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      current += ch + body[i + 1];
      i++;
      continue;
    }
    if (ch === "|" && parts.length < limit - 1) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Classifies the inner text of a `{…}` token.
 *
 * - `{?name}`, `{!name}`, `{/name}` are conditional section tags. The name may
 *   not contain `|`; otherwise the token is an ordinary variable.
 * - `{name|default|description}` is a variable. Each part is trimmed and
 *   unescaped. A default is present whenever a `|` is (it may be empty), and
 *   anything after the second unescaped `|` belongs to the description.
 */
export function parseVariableBody(inner: string): ParsedVariableBody {
  const prefix = CONDITIONAL_PREFIXES[inner[0]];
  if (prefix) {
    const name = inner.slice(1).trim();
    if (name && !/[|\\]/.test(name)) {
      return { kind: "conditional", conditional: prefix, name };
    }
  }

  const [rawName, rawDefault, rawDescription] = splitUnescapedPipes(inner, 3);
  const parsed: ParsedVariableBody = {
    kind: "variable",
    name: unescapeVariableText(rawName.trim()),
  };
  if (rawDefault !== undefined) {
    parsed.defaultValue = unescapeVariableText(rawDefault.trim());
  }
  if (rawDescription !== undefined) {
    parsed.description = unescapeVariableText(rawDescription.trim());
  }
  return parsed;
}

/**
 * Whether a supplied value counts as "set" for a `{?name}` condition:
 * not `null`/`undefined`/`false`, and not blank once stringified.
 */
export function isPromptValueSet(value: PromptValue): boolean {
  if (value === null || value === undefined || value === false) return false;
  return String(value).trim() !== "";
}

/**
 * Returns the text a supplied value substitutes, or `undefined` when the
 * variable should fall back to its default. An explicit empty string is a
 * value (it renders as nothing); `null`/`undefined` are not.
 */
export function getSuppliedValue(
  values: PromptValues,
  name: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(values, name)) return undefined;
  const value = values[name];
  if (value === null || value === undefined) return undefined;
  return String(value);
}

/**
 * Whether a section opened by `{?name}` / `{!name}` keeps its body. With a
 * `comparison` (from `{?name>3}`), the supplied value is compared instead of
 * tested for presence; a missing value compares as `""`.
 */
export function evaluateCondition(
  conditional: Exclude<ConditionalKind, "end">,
  name: string,
  values: PromptValues,
  comparison?: ConditionComparison,
): boolean {
  const holds = comparison
    ? compareConditionValues(
        getSuppliedValue(values, name) ?? "",
        comparison.operator,
        comparison.operand,
      )
    : isPromptValueSet(values[name]);
  return conditional === "if" ? holds : !holds;
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** Parses a plain decimal number (surrounding whitespace allowed), or `undefined`. */
function parseComparableNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Compares two texts like a mail-merge `IF` field: as numbers when both parse
 * as plain decimal numbers (so `"7"` equals `"7.0"`), otherwise as
 * case-insensitive text.
 */
export function compareConditionValues(
  left: string,
  operator: ComparisonOperator,
  right: string,
): boolean {
  const a = parseComparableNumber(left);
  const b = parseComparableNumber(right);
  let order: number;
  if (a !== undefined && b !== undefined) {
    order = a === b ? 0 : a < b ? -1 : 1;
  } else {
    const x = left.toLowerCase();
    const y = right.toLowerCase();
    order = x === y ? 0 : x < y ? -1 : 1;
  }
  switch (operator) {
    case "=":
      return order === 0;
    case "<>":
      return order !== 0;
    case "<":
      return order < 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case ">=":
      return order >= 0;
    default:
      return false;
  }
}

/**
 * Subject, operator and rest of a comparison. The subject runs up to the
 * first `=`, `<`, `>` or `!=` and may not contain `!`.
 */
const COMPARISON_PATTERN = /^([^=<>!]+?)\s*(<>|<=|>=|!=|=|<|>)\s*([\s\S]*)$/;

/**
 * The variable a conditional tag name compares when it is written as a
 * comparison (`amount>100` → `amount`), or `undefined`. A tag only acts as a
 * comparison when it is closed by `{/subject}`.
 */
export function conditionSubject(name: string): string | undefined {
  const match = COMPARISON_PATTERN.exec(name.trim());
  if (!match) return undefined;
  return match[1].trim() || undefined;
}

export type ParsedComparison =
  | { subject: string; comparison: ConditionComparison; error?: undefined }
  | { subject: string; comparison?: undefined; error: string };

/**
 * Parses a comparison condition such as `amount >= 100`, `status=paid`,
 * `status <> "on hold"` or `note=""`. Returns `undefined` when `text` has no
 * subject and operator, or an `error` when the comparison is malformed
 * (missing value, doubled operator, unterminated quote). `!=` is accepted as
 * a synonym for `<>`.
 */
export function parseComparison(text: string): ParsedComparison | undefined {
  const match = COMPARISON_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const subject = match[1].trim();
  if (!subject) return undefined;
  const written = match[2];
  const operator = (written === "!=" ? "<>" : written) as ComparisonOperator;
  const rest = match[3];
  if (rest === "") {
    return {
      subject,
      error: `Missing value after "${written}" (write "" to compare with an empty value)`,
    };
  }
  if (rest.startsWith('"')) {
    if (rest.length < 2 || !rest.endsWith('"')) {
      return { subject, error: `Unterminated quote in ${rest}` };
    }
    return { subject, comparison: { operator, operand: rest.slice(1, -1) } };
  }
  if (/^[=<>!]/.test(rest)) {
    return {
      subject,
      error: `Unexpected "${rest[0]}" after "${written}"; operators are = <> < > <= >=`,
    };
  }
  return { subject, comparison: { operator, operand: rest } };
}

/** Writes a comparison operand back as condition text, quoting it when needed. */
export function formatComparisonOperand(operand: string): string {
  return operand === "" ||
    operand !== operand.trim() ||
    /^[=<>!"]/.test(operand)
    ? `"${operand}"`
    : operand;
}

/**
 * The display form of a conditional tag: `{?name}`, `{!name}`, `{/name}`, or
 * `{?amount>100}` for a comparison.
 */
export function formatConditionalTag(tag: {
  conditional?: ConditionalKind;
  value: string;
  comparison?: ConditionComparison;
}): string {
  const prefix =
    tag.conditional === "unless" ? "!" : tag.conditional === "end" ? "/" : "?";
  const comparison = tag.comparison
    ? `${tag.comparison.operator}${formatComparisonOperand(tag.comparison.operand)}`
    : "";
  return `{${prefix}${tag.value}${comparison}}`;
}

/** A tooltip for a conditional tag, e.g. `Shown when "amount" > 100`. */
export function describeConditionalTag(tag: {
  conditional?: ConditionalKind;
  value: string;
  comparison?: ConditionComparison;
}): string {
  if (tag.conditional === "end") return `End of section: ${tag.value}`;
  const shown = tag.conditional === "unless" ? "Hidden" : "Shown";
  if (tag.comparison) {
    return `${shown} when "${tag.value}" ${tag.comparison.operator} ${formatComparisonOperand(tag.comparison.operand)}`;
  }
  return tag.conditional === "unless"
    ? `Shown when "${tag.value}" is empty`
    : `Shown when "${tag.value}" has a value`;
}

/** A parsed standalone condition (see `parseConditionExpression`). */
export interface ConditionExpression {
  /** `true` for `!name` / `!name=value`: the condition is inverted. */
  negated: boolean;
  name: string;
  comparison?: ConditionComparison;
}

/**
 * Parses a condition written like the inside of a section tag, without the
 * braces: `vip` (has a value), `!vip` (has none), `amount>100`,
 * `!status=paid`. A leading `?` is allowed. Used by options such as
 * `mergeRecords({ skipIf })`. Returns `{ error }` for malformed text.
 */
export function parseConditionExpression(
  text: string,
): ConditionExpression | { error: string } {
  let body = text.trim();
  let negated = false;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1).trim();
  } else if (body.startsWith("?")) {
    body = body.slice(1).trim();
  }
  if (!body) return { error: "Empty condition" };
  const parsed = parseComparison(body);
  if (parsed?.error !== undefined) return { error: parsed.error };
  if (parsed) {
    return { negated, name: parsed.subject, comparison: parsed.comparison };
  }
  if (/[=<>!]/.test(body)) {
    return { error: `Malformed condition: ${text.trim()}` };
  }
  return { negated, name: body };
}

/** Evaluates a parsed condition expression against values. */
export function evaluateConditionExpression(
  expression: ConditionExpression,
  values: PromptValues,
): boolean {
  return evaluateCondition(
    expression.negated ? "unless" : "if",
    expression.name,
    values,
    expression.comparison,
  );
}

export interface ConditionalTagLike {
  conditional: ConditionalKind;
  name: string;
}

export interface ConditionalTagMatch {
  /** Index of the partner tag, or -1 when the tag is unbalanced. */
  partner: number;
  /** Set when unbalanced, or on both tags of a malformed comparison pair. */
  error?: "unclosed-section" | "unexpected-close" | "invalid-condition";
  /**
   * Set on both tags of a pair whose open tag is a comparison closed by its
   * subject (`{?amount>100}…{/amount}`).
   */
  comparison?: ParsedComparison;
}

/**
 * Pairs conditional tags given in document order. A close tag pairs with the
 * nearest open tag of the same name, or with the nearest open comparison tag
 * whose subject it names (`{?amount>100}` is closed by `{/amount}`; closing
 * it with `{/amount>100}` keeps the old meaning, a presence check on a
 * variable named `amount>100`). Open tags skipped over are reported as
 * unclosed, a close tag with no open partner as unexpected, and a malformed
 * comparison pair as an invalid condition. Unbalanced tags never throw:
 * callers treat them as literal text. The surviving pairs are always properly
 * nested.
 */
export function matchConditionalTags(
  tags: ConditionalTagLike[],
): ConditionalTagMatch[] {
  const result: ConditionalTagMatch[] = tags.map(() => ({ partner: -1 }));
  const stack: number[] = [];
  const subjects = tags.map((tag) =>
    tag.conditional === "end" ? undefined : conditionSubject(tag.name),
  );

  tags.forEach((tag, index) => {
    if (tag.conditional !== "end") {
      stack.push(index);
      return;
    }
    let depth = stack.length - 1;
    while (
      depth >= 0 &&
      tags[stack[depth]].name !== tag.name &&
      subjects[stack[depth]] !== tag.name
    ) {
      depth--;
    }
    if (depth < 0) {
      result[index].error = "unexpected-close";
      return;
    }
    // Everything opened after the partner was never closed.
    for (const skipped of stack.splice(depth + 1)) {
      result[skipped].error = "unclosed-section";
    }
    const open = stack.pop()!;
    if (tags[open].name !== tag.name) {
      const comparison = parseComparison(tags[open].name)!;
      result[open].comparison = result[index].comparison = comparison;
      if (comparison.error !== undefined) {
        result[open].error = result[index].error = "invalid-condition";
        return;
      }
    }
    result[open].partner = index;
    result[index].partner = open;
  });

  for (const open of stack) {
    result[open].error = "unclosed-section";
  }
  return result;
}
