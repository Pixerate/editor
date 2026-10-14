import type { PromptDiagnostic, Template } from "./tokens";
import type { ResolveTemplatesOptions } from "./resolver";
import { resolvePrompt } from "./engine";
import { getPromptDiagnostics } from "./tokenizer";

/**
 * One contiguous piece of resolved output and the raw range it came from.
 *
 * - `raw`: copied verbatim; offsets map character by character.
 * - `template`: the expansion of a `{{template}}` tag.
 * - `variable`: a substituted value or `|default` for a `{variable}` tag.
 * - `conditional`: a section tag, or a whole removed section. These segments
 *   are empty in the resolved text (`resolvedStart === resolvedEnd`).
 *
 * Offsets inside non-raw segments map to the start of their raw range.
 */
export interface SourceMapSegment {
  resolvedStart: number;
  resolvedEnd: number;
  source: "raw" | "template" | "variable" | "conditional";
  rawStart: number;
  rawEnd: number;
  templateName?: string;
  /** Variable substituted (`variable`) or tested (`conditional`). */
  variableName?: string;
  /** For `variable` segments: whether a supplied value or the default was used. */
  valueSource?: "value" | "default";
}

/**
 * Resolves templates in text while tracking character offset mapping
 * between the raw input and the fully resolved output.
 *
 * Pass `options.values` to also substitute variables and evaluate conditional
 * sections (see `resolvePrompt`); without it the output is unchanged from the
 * template-only behavior.
 */
export function resolveTemplatesWithMapping(
  text: string,
  templates: Template[] = [],
  templateBindings?: Record<string, string>,
  options?: Pick<ResolveTemplatesOptions, "maxDepth" | "values">,
): { text: string; map: SourceMapSegment[]; diagnostics: PromptDiagnostic[] } {
  if (
    options?.values === undefined &&
    (!templates || templates.length === 0 || !text.includes("{{"))
  ) {
    return {
      diagnostics: getPromptDiagnostics(text),
      text,
      map: [
        {
          resolvedStart: 0,
          resolvedEnd: text.length,
          source: "raw",
          rawStart: 0,
          rawEnd: text.length,
        },
      ],
    };
  }

  return resolvePrompt(text, templates, {
    bindings: templateBindings,
    maxDepth: options?.maxDepth,
    values: options?.values,
  });
}

/**
 * Maps an offset in resolved text back to the corresponding offset in raw text.
 */
export function mapResolvedOffsetToRaw(
  resolvedOffset: number,
  map: SourceMapSegment[],
): number {
  for (let i = 0; i < map.length; i++) {
    const seg = map[i];
    const isLast = i === map.length - 1;
    const inRange = isLast
      ? resolvedOffset >= seg.resolvedStart && resolvedOffset <= seg.resolvedEnd
      : resolvedOffset >= seg.resolvedStart && resolvedOffset < seg.resolvedEnd;

    if (inRange) {
      if (seg.source === "raw") {
        return seg.rawStart + (resolvedOffset - seg.resolvedStart);
      }
      // The end of the text maps to the end of the tag; anywhere inside a
      // resolved template maps to the start of its tag.
      if (resolvedOffset === seg.resolvedEnd) {
        return seg.rawEnd;
      }
      return seg.rawStart;
    }
  }
  return resolvedOffset;
}

/**
 * Maps an offset in raw text to the corresponding offset in resolved text.
 */
export function mapRawOffsetToResolved(
  rawOffset: number,
  map: SourceMapSegment[],
): number {
  for (let i = 0; i < map.length; i++) {
    const seg = map[i];
    const isLast = i === map.length - 1;
    const inRange = isLast
      ? rawOffset >= seg.rawStart && rawOffset <= seg.rawEnd
      : rawOffset >= seg.rawStart && rawOffset < seg.rawEnd;

    if (inRange) {
      if (seg.source === "raw") {
        return seg.resolvedStart + (rawOffset - seg.rawStart);
      }
      if (rawOffset === seg.rawEnd) {
        return seg.resolvedEnd;
      }
      return seg.resolvedStart;
    }
  }
  return rawOffset;
}
