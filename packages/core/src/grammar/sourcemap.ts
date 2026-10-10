import { TEMPLATE_REGEX, Template } from "./tokens";
import {
  getTemplateBody,
  resolveTemplates,
  type ResolveTemplatesOptions,
} from "./resolver";

export interface SourceMapSegment {
  resolvedStart: number;
  resolvedEnd: number;
  source: "raw" | "template";
  rawStart: number;
  rawEnd: number;
  templateName?: string;
}

/**
 * Resolves templates in text while tracking character offset mapping
 * between the raw input and the fully resolved output.
 */
export function resolveTemplatesWithMapping(
  text: string,
  templates: Template[] = [],
  templateBindings?: Record<string, string>,
  options?: Pick<ResolveTemplatesOptions, "maxDepth">,
): { text: string; map: SourceMapSegment[] } {
  if (!templates || templates.length === 0 || !text.includes("{{")) {
    return {
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

  const templateMap = new Map(templates.map((t) => [t.name, t]));
  const regex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let resolvedText = "";
  const map: SourceMapSegment[] = [];

  while ((match = regex.exec(text)) !== null) {
    const [fullMatch, rawTemplateName] = match;
    const templateName = rawTemplateName.trim();
    const matchIndex = match.index;

    // Add raw text preceding this template match
    if (matchIndex > lastIndex) {
      const rawSegment = text.substring(lastIndex, matchIndex);
      map.push({
        resolvedStart: resolvedText.length,
        resolvedEnd: resolvedText.length + rawSegment.length,
        source: "raw",
        rawStart: lastIndex,
        rawEnd: matchIndex,
      });
      resolvedText += rawSegment;
    }

    let resolvedBody = fullMatch;
    let isTemplate = false;

    const template = templateMap.get(templateName);
    if (template && getTemplateBody(template, templateBindings) !== undefined) {
      // Resolve the tag itself so loop and depth handling match resolveTemplates.
      resolvedBody = resolveTemplates(fullMatch, templates, {
        bindings: templateBindings,
        maxDepth: options?.maxDepth,
      });
      isTemplate = true;
    }

    if (isTemplate) {
      map.push({
        resolvedStart: resolvedText.length,
        resolvedEnd: resolvedText.length + resolvedBody.length,
        source: "template",
        rawStart: matchIndex,
        rawEnd: matchIndex + fullMatch.length,
        templateName,
      });
      resolvedText += resolvedBody;
    } else {
      map.push({
        resolvedStart: resolvedText.length,
        resolvedEnd: resolvedText.length + fullMatch.length,
        source: "raw",
        rawStart: matchIndex,
        rawEnd: matchIndex + fullMatch.length,
      });
      resolvedText += fullMatch;
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  // Add any remaining raw text after the final match
  if (lastIndex < text.length) {
    const rawSegment = text.substring(lastIndex);
    map.push({
      resolvedStart: resolvedText.length,
      resolvedEnd: resolvedText.length + rawSegment.length,
      source: "raw",
      rawStart: lastIndex,
      rawEnd: text.length,
    });
    resolvedText += rawSegment;
  }

  return { text: resolvedText, map };
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
