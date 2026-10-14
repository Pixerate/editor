/**
 * Canonical regex patterns for prompt editing tokens.
 */
export const TEMPLATE_REGEX = /{{\s*([^}]+?)\s*}}/g;
/**
 * `{name}`, `{name|default}`, `{name|default|description}` and the conditional
 * section tags `{?name}`, `{!name}` and `{/name}`. A backslash escapes the next
 * character, so `\}`, `\{` and `\|` can appear inside defaults and descriptions.
 * Without backslashes this matches exactly what the original `[^{}]+` pattern did.
 */
export const VARIABLE_REGEX =
  /(?<!\{)\{(?!\})((?:\\[\s\S]|[^{}\\])*\\?)\}(?!\})/g;
export const INSTRUCTION_REGEX = /__(.+?)__/g;

// Backward-compatible camelCase aliases
export const templateRegex = TEMPLATE_REGEX;
export const variableRegex = VARIABLE_REGEX;
export const instructionRegex = INSTRUCTION_REGEX;

export type TokenType =
  | "template"
  | "variable"
  | "instruction"
  | "conditional"
  | "text";

/**
 * Kind of a conditional section tag: `{?name}` opens a section kept when
 * `name` has a value, `{!name}` opens one kept when it has none, and
 * `{/name}` closes either.
 */
export type ConditionalKind = "if" | "unless" | "end";

export interface Token {
  type: TokenType;
  raw: string;
  /** Trimmed name for templates, variables and conditional tags; content otherwise. */
  value: string;
  start: number;
  end: number;
  /** Variables only: unescaped text after the first `|` (may be empty). */
  defaultValue?: string;
  /** Variables only: unescaped text after the second `|` (fill-in prompt). */
  description?: string;
  /** Conditional tags only. */
  conditional?: ConditionalKind;
}

/** Values supplied for `{variable}` slots and `{?variable}` conditions. */
export type PromptValue = string | number | boolean | null | undefined;
export type PromptValues = Record<string, PromptValue>;

export type PromptDiagnosticCode = "unclosed-section" | "unexpected-close";

/**
 * A recoverable grammar problem. The offending tag is treated as literal text.
 * Offsets are relative to the text that contained the tag: the input prompt,
 * or the body of `templateName` when set.
 */
export interface PromptDiagnostic {
  code: PromptDiagnosticCode;
  message: string;
  /** Variable named by the tag. */
  name: string;
  start: number;
  end: number;
  templateName?: string;
}

export interface TemplateVersion {
  id: string;
  version: string | number;
  body: string;
  createdAt?: any;
  [key: string]: any;
}

export interface Template {
  id?: string;
  name: string;
  body?: string;
  latestVersion?: string | number;
  versions?: TemplateVersion[];
  color?: string;
  [key: string]: any;
}

export interface ColorGradient {
  from: string;
  to: string;
}
