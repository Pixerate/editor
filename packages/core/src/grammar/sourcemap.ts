import { Template } from "./tokens";
import { getLatestVersion, resolveTemplates } from "./resolver";

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
  const regex = /{{\s*([^}]+?)\s*}}/g;
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

    if (templateMap.has(templateName)) {
      const template = templateMap.get(templateName)!;
      let versionBody: string | undefined;
      const boundVersionId = templateBindings?.[templateName];

      if (boundVersionId && template.versions) {
        const boundVersion = template.versions.find(
          (v) => v.id === boundVersionId || v.version === boundVersionId,
        );
        versionBody = boundVersion?.body;
      } else {
        const latestVersion = getLatestVersion(template);
        versionBody = latestVersion?.body ?? template.body;
      }

      if (versionBody !== undefined) {
        resolvedBody = resolveTemplates(versionBody, templates, {
          bindings: templateBindings,
        });
        isTemplate = true;
      }
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
      } else {
        // Pointing into a resolved template - return start of template tag
        return seg.rawStart;
      }
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
      } else {
        return seg.resolvedStart;
      }
    }
  }
  return rawOffset;
}
