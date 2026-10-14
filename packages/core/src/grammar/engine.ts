import type {
  PromptDiagnostic,
  PromptValues,
  Template,
  TemplateVersion,
  Token,
} from "./tokens";
import type { SourceMapSegment } from "./sourcemap";
import { tokenizePromptWithDiagnostics } from "./tokenizer";
import { evaluateCondition, getSuppliedValue } from "./variables";

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

export interface ResolvePromptOptions {
  /** Template version bindings (`{ templateName: versionIdOrVersion }`). */
  bindings?: Record<string, string>;
  /** Maximum template nesting depth (default 10). */
  maxDepth?: number;
  /**
   * Values for `{variable}` slots and `{?variable}` / `{!variable}` sections.
   * When omitted, variables and section tags are left exactly as written.
   */
  values?: PromptValues;
}

export interface ResolvePromptResult {
  text: string;
  map: SourceMapSegment[];
  diagnostics: PromptDiagnostic[];
}

type Segment = SourceMapSegment & { locked?: boolean };

/** Accumulates resolved text and, at the top level, source map segments. */
class Output {
  text = "";
  constructor(readonly segments: Segment[] | null) {}

  /** Text copied verbatim from the raw input. Locked segments never merge. */
  raw(rawStart: number, rawEnd: number, value: string, locked = false) {
    const resolvedStart = this.text.length;
    this.text += value;
    if (!this.segments) return;
    const last = this.segments[this.segments.length - 1];
    if (
      !locked &&
      last &&
      last.source === "raw" &&
      !last.locked &&
      last.rawEnd === rawStart &&
      last.resolvedEnd === resolvedStart
    ) {
      last.rawEnd = rawEnd;
      last.resolvedEnd = this.text.length;
      return;
    }
    this.segments.push({
      resolvedStart,
      resolvedEnd: this.text.length,
      source: "raw",
      rawStart,
      rawEnd,
      ...(locked ? { locked } : {}),
    });
  }

  /** Text that replaces a raw range (template body, value, removed section). */
  replaced(
    rawStart: number,
    rawEnd: number,
    value: string,
    extra: Pick<
      SourceMapSegment,
      "source" | "templateName" | "variableName" | "valueSource"
    >,
  ) {
    const resolvedStart = this.text.length;
    this.text += value;
    this.segments?.push({
      resolvedStart,
      resolvedEnd: this.text.length,
      rawStart,
      rawEnd,
      ...extra,
    });
  }
}

/** Pairs balanced conditional tokens (the tokenizer guarantees nesting). */
function pairSections(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== "conditional") return;
    if (token.conditional === "end") {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    } else {
      stack.push(index);
    }
  });
  return pairs;
}

/**
 * Resolves a prompt: expands `{{templates}}` recursively (with loop and depth
 * protection), and, when `values` are given, substitutes `{variables}` (falling
 * back to their `|default`) and keeps or removes `{?name}…{/name}` sections.
 *
 * Template bodies are parsed on their own, so a section must open and close
 * within the same body. Templates inside a removed section are never expanded
 * and cannot trigger loop or depth errors. Unbalanced section tags are kept as
 * literal text and reported in `diagnostics`.
 *
 * Returns the resolved text, a source map from resolved to raw offsets, and
 * diagnostics. With no `values` the text matches the original template-only
 * resolver exactly.
 */
export function resolvePrompt(
  text: string,
  templates: Template[] = [],
  options: ResolvePromptOptions = {},
): ResolvePromptResult {
  const templateMap = new Map<string, Template>();
  for (const t of templates) {
    templateMap.set(t.name, t);
  }
  const maxDepth = options.maxDepth ?? 10;
  const values = options.values;
  const diagnostics: PromptDiagnostic[] = [];
  const reported = new Set<string>();

  function resolveInto(
    source: string,
    out: Output,
    visited: Set<string>,
    depth: number,
    templateName: string | undefined,
  ): void {
    const { tokens, diagnostics: found } =
      tokenizePromptWithDiagnostics(source);
    for (const diagnostic of found) {
      const key = `${templateName ?? ""}\u0000${diagnostic.start}\u0000${diagnostic.code}`;
      if (reported.has(key)) continue;
      reported.add(key);
      diagnostics.push(
        templateName === undefined ? diagnostic : { ...diagnostic, templateName },
      );
    }
    const pairs = values ? pairSections(tokens) : null;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (token.type === "template") {
        const name = token.value;
        if (visited.has(name)) {
          out.replaced(token.start, token.end, TEMPLATE_LOOP_ERROR, {
            source: "template",
            templateName: name,
          });
          continue;
        }
        const template = templateMap.get(name);
        const body = template
          ? getTemplateBody(template, options.bindings)
          : undefined;
        if (body === undefined) {
          out.raw(token.start, token.end, token.raw, true);
          continue;
        }
        if (depth + 1 > maxDepth) {
          out.replaced(token.start, token.end, TEMPLATE_DEPTH_ERROR, {
            source: "template",
            templateName: name,
          });
          continue;
        }
        const nested = new Output(null);
        const nextVisited = new Set(visited);
        nextVisited.add(name);
        resolveInto(body, nested, nextVisited, depth + 1, name);
        out.replaced(token.start, token.end, nested.text, {
          source: "template",
          templateName: name,
        });
        continue;
      }

      if (values && token.type === "variable") {
        const supplied = getSuppliedValue(values, token.value);
        const value = supplied ?? token.defaultValue;
        if (value !== undefined) {
          out.replaced(token.start, token.end, value, {
            source: "variable",
            variableName: token.value,
            valueSource: supplied !== undefined ? "value" : "default",
          });
          continue;
        }
      }

      if (values && token.type === "conditional" && token.conditional) {
        const tagInfo = {
          source: "conditional" as const,
          variableName: token.value,
        };
        if (token.conditional !== "end") {
          const close = pairs!.get(i)!;
          if (
            !evaluateCondition(
              token.conditional,
              token.value,
              values,
              token.comparison,
            )
          ) {
            // Drop the whole section, tags included.
            out.replaced(token.start, tokens[close].end, "", tagInfo);
            i = close;
            continue;
          }
        }
        out.replaced(token.start, token.end, "", tagInfo);
        continue;
      }

      out.raw(token.start, token.end, token.raw);
    }
  }

  const out = new Output([]);
  resolveInto(text, out, new Set(), 0, undefined);

  const map: SourceMapSegment[] = out.segments!.map(
    ({ locked: _locked, ...segment }) => segment,
  );
  if (map.length === 0) {
    map.push({
      resolvedStart: 0,
      resolvedEnd: 0,
      source: "raw",
      rawStart: 0,
      rawEnd: 0,
    });
  }
  return { text: out.text, map, diagnostics };
}

/** A token annotated with the value it resolves to. */
export interface EvaluatedToken extends Token {
  /** Variables only, when values were given: the substituted text. */
  resolvedValue?: string;
  /** Variables only: whether `resolvedValue` came from `values` or the default. */
  valueSource?: "value" | "default";
}

/**
 * Tokenizes a prompt for display. Without `values` this is `tokenizePrompt`.
 * With `values`, sections whose condition fails are removed (tags included),
 * the tags of kept sections are dropped, and each variable that has a value or
 * a default carries it in `resolvedValue`. Templates are not expanded; resolve
 * them first (without values) if the display should show their bodies.
 */
export function evaluatePromptTokens(
  text: string,
  values?: PromptValues,
): EvaluatedToken[] {
  const tokens = tokenizePromptWithDiagnostics(text).tokens;
  if (!values) return tokens;

  const pairs = pairSections(tokens);
  const result: EvaluatedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "conditional") {
      if (
        token.conditional !== "end" &&
        !evaluateCondition(
          token.conditional!,
          token.value,
          values,
          token.comparison,
        )
      ) {
        i = pairs.get(i)!;
      }
      continue;
    }
    if (token.type === "variable") {
      const supplied = getSuppliedValue(values, token.value);
      const value = supplied ?? token.defaultValue;
      if (value !== undefined) {
        result.push({
          ...token,
          resolvedValue: value,
          valueSource: supplied !== undefined ? "value" : "default",
        });
        continue;
      }
    }
    result.push(token);
  }
  return result;
}
