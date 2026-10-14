import type { ConditionalKind, PromptValue, PromptValues } from "./tokens";

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

/** Whether a section opened by `{?name}` / `{!name}` keeps its body. */
export function evaluateCondition(
  conditional: Exclude<ConditionalKind, "end">,
  name: string,
  values: PromptValues,
): boolean {
  const set = isPromptValueSet(values[name]);
  return conditional === "if" ? set : !set;
}

export interface ConditionalTagLike {
  conditional: ConditionalKind;
  name: string;
}

export interface ConditionalTagMatch {
  /** Index of the partner tag, or -1 when the tag is unbalanced. */
  partner: number;
  /** Set when unbalanced. */
  error?: "unclosed-section" | "unexpected-close";
}

/**
 * Pairs conditional tags given in document order. A close tag pairs with the
 * nearest open tag of the same name; open tags skipped over are reported as
 * unclosed, and a close tag with no open partner as unexpected. Unbalanced tags
 * never throw: callers treat them as literal text. The surviving pairs are
 * always properly nested.
 */
export function matchConditionalTags(
  tags: ConditionalTagLike[],
): ConditionalTagMatch[] {
  const result: ConditionalTagMatch[] = tags.map(() => ({ partner: -1 }));
  const stack: number[] = [];

  tags.forEach((tag, index) => {
    if (tag.conditional !== "end") {
      stack.push(index);
      return;
    }
    let depth = stack.length - 1;
    while (depth >= 0 && tags[stack[depth]].name !== tag.name) depth--;
    if (depth < 0) {
      result[index].error = "unexpected-close";
      return;
    }
    // Everything opened after the partner was never closed.
    for (const skipped of stack.splice(depth + 1)) {
      result[skipped].error = "unclosed-section";
    }
    const open = stack.pop()!;
    result[open].partner = index;
    result[index].partner = open;
  });

  for (const open of stack) {
    result[open].error = "unclosed-section";
  }
  return result;
}
