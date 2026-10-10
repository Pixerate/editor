import {
  TEMPLATE_REGEX,
  VARIABLE_REGEX,
  INSTRUCTION_REGEX,
  Template,
  TemplateVersion,
} from "./tokens";

/**
 * Finds the latest version of a template based on `latestVersion` or last version entry.
 */
export function getLatestVersion(
  template: Template,
): TemplateVersion | undefined {
  if (!template.versions || template.versions.length === 0) {
    if (template.body !== undefined) {
      return {
        id: template.id || "default",
        version: "1.0",
        body: template.body,
      };
    }
    return undefined;
  }
  if (template.latestVersion) {
    const found = template.versions.find(
      (v) => v.version === template.latestVersion,
    );
    if (found) return found;
  }
  return template.versions[template.versions.length - 1];
}

export interface ResolveTemplatesOptions {
  bindings?: Record<string, string>;
  maxDepth?: number;
}

/** Marker substituted for a template tag that would recurse into itself. */
export const TEMPLATE_LOOP_ERROR = "[Template loop detected]";
/** Marker substituted for a template tag nested deeper than `maxDepth`. */
export const TEMPLATE_DEPTH_ERROR = "[Template max depth exceeded]";

/**
 * Returns the body a template tag resolves to, honoring version bindings.
 */
export function getTemplateBody(
  template: Template,
  bindings?: Record<string, string>,
): string | undefined {
  const boundVersionId = bindings?.[template.name];
  if (boundVersionId && template.versions) {
    const boundVersion = template.versions.find(
      (v) => v.id === boundVersionId || v.version === boundVersionId,
    );
    return boundVersion?.body;
  }
  return getLatestVersion(template)?.body ?? template.body;
}

/**
 * Recursively resolves template tags `{{template_name}}` in a given text.
 * A tag that would recurse into itself is replaced with `TEMPLATE_LOOP_ERROR`,
 * and a tag nested deeper than `maxDepth` with `TEMPLATE_DEPTH_ERROR`; the rest
 * of the text still resolves normally.
 */
export function resolveTemplates(
  text: string,
  templates: Template[] = [],
  options?: ResolveTemplatesOptions,
): string {
  const templateMap = new Map<string, Template>();
  for (const t of templates) {
    templateMap.set(t.name, t);
  }

  const maxDepth = options?.maxDepth ?? 10;

  function resolveRecursive(
    currentText: string,
    visited: Set<string>,
    depth: number,
  ): string {
    const regex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);

    // A function replacer keeps `$&`, `$'` etc. in template bodies literal.
    return currentText.replace(regex, (fullMatch, rawTemplateName: string) => {
      const templateName = rawTemplateName.trim();

      if (visited.has(templateName)) {
        return TEMPLATE_LOOP_ERROR;
      }

      const template = templateMap.get(templateName);
      if (!template) {
        return fullMatch;
      }

      const versionBody = getTemplateBody(template, options?.bindings);
      if (versionBody === undefined) {
        return fullMatch;
      }

      if (depth + 1 > maxDepth) {
        return TEMPLATE_DEPTH_ERROR;
      }

      const nextVisited = new Set(visited);
      nextVisited.add(templateName);

      return resolveRecursive(versionBody, nextVisited, depth + 1);
    });
  }

  return resolveRecursive(text, new Set(), 0);
}

/**
 * Replaces `{variableName}` with values from a dictionary.
 */
export function resolveVariables(
  text: string,
  values: Record<string, string | number>,
): string {
  if (!text) return "";
  return text.replace(
    new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags),
    (fullMatch, varName) => {
      const key = varName.trim();
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return String(values[key]);
      }
      return fullMatch;
    },
  );
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
 * Extracts unique variable names referenced in text.
 */
export function extractVariableNames(text: string): string[] {
  if (!text) return [];
  const set = new Set<string>();
  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    set.add(match[1].trim());
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
