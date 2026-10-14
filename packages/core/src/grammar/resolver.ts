import {
  TEMPLATE_REGEX,
  VARIABLE_REGEX,
  INSTRUCTION_REGEX,
  Template,
  PromptValues,
} from "./tokens";
import { resolvePrompt } from "./engine";
import { conditionSubject, parseVariableBody } from "./variables";
import { tokenizePrompt } from "./tokenizer";

export interface ResolveTemplatesOptions {
  bindings?: Record<string, string>;
  maxDepth?: number;
  /**
   * Values for `{variable}` slots and `{?variable}` sections. When omitted,
   * variables, defaults and section tags are left exactly as written.
   */
  values?: PromptValues;
}

/**
 * Recursively resolves template tags `{{template_name}}` in a given text.
 * A tag that would recurse into itself is replaced with `TEMPLATE_LOOP_ERROR`,
 * and a tag nested deeper than `maxDepth` with `TEMPLATE_DEPTH_ERROR`; the rest
 * of the text still resolves normally.
 *
 * Pass `options.values` to also fill variables (falling back to their
 * `{name|default}`) and evaluate `{?name}…{/name}` / `{!name}…{/name}`
 * sections, including those inside template bodies. See `resolvePrompt` for
 * the source map and diagnostics.
 */
export function resolveTemplates(
  text: string,
  templates: Template[] = [],
  options?: ResolveTemplatesOptions,
): string {
  return resolvePrompt(text, templates, options).text;
}

/**
 * Replaces `{variableName}` with values from a dictionary, falling back to a
 * `{variableName|default}` when no value is supplied, and evaluates
 * `{?name}…{/name}` / `{!name}…{/name}` sections. Variables with neither a
 * value nor a default are left as written. Templates are not expanded.
 */
export function resolveVariables(
  text: string,
  values: PromptValues,
): string {
  if (!text) return "";
  return resolvePrompt(text, [], { values }).text;
}

/**
 * Extracts unique template names referenced in text.
 */
export function extractTemplateNames(text: string): string[] {
  if (!text) return [];
  const set = new Set<string>();
  const regex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    set.add(match[1].trim());
  }
  return Array.from(set);
}

/**
 * Extracts unique variable names referenced in text, including names used by
 * conditional section tags (`amount` for `{?amount>100}…{/amount}`).
 * Defaults and descriptions are stripped.
 */
export function extractVariableNames(text: string): string[] {
  if (!text) return [];
  const set = new Set<string>();
  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);
  let comparisonStarts: Set<number> | undefined;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const parsed = parseVariableBody(match[1]);
    let name = parsed.name;
    if (parsed.kind === "conditional" && parsed.conditional !== "end") {
      const subject = conditionSubject(name);
      if (subject) {
        // Only a tag closed by `{/subject}` is a comparison on `subject`.
        comparisonStarts ??= new Set(
          tokenizePrompt(text)
            .filter((token) => token.comparison)
            .map((token) => token.start),
        );
        if (comparisonStarts.has(match.index)) name = subject;
      }
    }
    set.add(name);
  }
  return Array.from(set);
}

/**
 * Extracts unique instruction names referenced in text.
 */
export function extractInstructionNames(text: string): string[] {
  if (!text) return [];
  const set = new Set<string>();
  const regex = new RegExp(INSTRUCTION_REGEX.source, INSTRUCTION_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    set.add(match[1].trim());
  }
  return Array.from(set);
}
