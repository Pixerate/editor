import type { PromptValues, Template } from "./tokens";
import { tokenizePrompt } from "./tokenizer";
import { getTemplateBody } from "./engine";

/** Everything a prompt (and, optionally, its templates) says about one variable. */
export interface VariableDescriptor {
  name: string;
  /** First `{name|default}` found. */
  defaultValue?: string;
  /** First `{name|default|description}` found. */
  description?: string;
  /** Appears as a `{name}` slot. */
  usedAsValue: boolean;
  /** Appears in a `{?name}` / `{!name}` condition (including comparisons). */
  usedInCondition: boolean;
  /**
   * Present (and `true`) when the variable is compared in a condition such as
   * `{?amount>100}`, so a form should ask for its text, not a checkbox.
   */
  usedInComparison?: true;
  /** Number of `{name…}` slots and condition tags (closing tags excluded). */
  occurrences: number;
  /** Templates whose bodies mention the variable, in discovery order. */
  templates: string[];
}

export interface ExtractVariablesOptions {
  /** Templates to search recursively for further variables. */
  templates?: Template[];
  bindings?: Record<string, string>;
  /** Maximum template nesting depth to search (default 10). */
  maxDepth?: number;
}

/**
 * Lists every variable a prompt uses, in order of first appearance, with its
 * default and description. Templates referenced by the prompt are searched
 * recursively when `options.templates` is given (loops are skipped). All
 * sections are searched, whatever their condition would evaluate to.
 */
export function extractVariables(
  text: string,
  options: ExtractVariablesOptions = {},
): VariableDescriptor[] {
  const descriptors = new Map<string, VariableDescriptor>();
  const templateMap = new Map(
    (options.templates ?? []).map((t) => [t.name, t] as const),
  );
  const maxDepth = options.maxDepth ?? 10;

  const describe = (name: string, templateName?: string) => {
    let descriptor = descriptors.get(name);
    if (!descriptor) {
      descriptor = {
        name,
        usedAsValue: false,
        usedInCondition: false,
        occurrences: 0,
        templates: [],
      };
      descriptors.set(name, descriptor);
    }
    descriptor.occurrences++;
    if (templateName && !descriptor.templates.includes(templateName)) {
      descriptor.templates.push(templateName);
    }
    return descriptor;
  };

  const visit = (
    source: string,
    visited: Set<string>,
    depth: number,
    templateName?: string,
  ) => {
    for (const token of tokenizePrompt(source)) {
      if (token.type === "variable") {
        const descriptor = describe(token.value, templateName);
        descriptor.usedAsValue = true;
        if (descriptor.defaultValue === undefined && token.defaultValue !== undefined) {
          descriptor.defaultValue = token.defaultValue;
        }
        if (descriptor.description === undefined && token.description !== undefined) {
          descriptor.description = token.description;
        }
      } else if (token.type === "conditional" && token.conditional !== "end") {
        const descriptor = describe(token.value, templateName);
        descriptor.usedInCondition = true;
        if (token.comparison) descriptor.usedInComparison = true;
      } else if (token.type === "template") {
        const template = templateMap.get(token.value);
        if (!template || visited.has(token.value) || depth + 1 > maxDepth) {
          continue;
        }
        const body = getTemplateBody(template, options.bindings);
        if (body === undefined) continue;
        visit(body, new Set(visited).add(token.value), depth + 1, token.value);
      }
    }
  };

  if (text) visit(text, new Set(), 0);
  return Array.from(descriptors.values());
}

/** A headless description of one input in a variable fill-in form. */
export interface VariableFormField {
  name: string;
  /** The variable's description, or its name. */
  label: string;
  /** The variable's default, or an empty string. */
  placeholder: string;
  defaultValue?: string;
  description?: string;
  /**
   * The variable is used as a slot and has no default, so leaving it blank
   * leaves the `{name}` placeholder in the resolved prompt.
   */
  required: boolean;
  /**
   * Only used by `{?name}` / `{!name}` presence conditions, never substituted
   * or compared (a form can show a checkbox).
   */
  conditionOnly: boolean;
}

/**
 * Builds field descriptors for a fill-in form (Word's FILLIN analogue): one
 * per variable, labelled with its description and using its default as the
 * placeholder. Feed the entered text through `compactVariableValues` before
 * resolving so blank inputs fall back to defaults.
 */
export function getVariableFormFields(
  text: string,
  options: ExtractVariablesOptions = {},
): VariableFormField[] {
  return extractVariables(text, options).map((variable) => ({
    name: variable.name,
    label: variable.description || variable.name,
    placeholder: variable.defaultValue ?? "",
    ...(variable.defaultValue !== undefined
      ? { defaultValue: variable.defaultValue }
      : {}),
    ...(variable.description !== undefined
      ? { description: variable.description }
      : {}),
    required: variable.usedAsValue && variable.defaultValue === undefined,
    conditionOnly: !variable.usedAsValue && !variable.usedInComparison,
  }));
}

/**
 * Drops blank entries from form input so the resolver falls back to each
 * variable's default (an explicit `""` value would otherwise render as empty).
 */
export function compactVariableValues(
  input: Record<string, string | null | undefined>,
): PromptValues {
  const values: PromptValues = {};
  for (const [name, value] of Object.entries(input)) {
    if (value !== null && value !== undefined && value.trim() !== "") {
      values[name] = value;
    }
  }
  return values;
}
