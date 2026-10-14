import React, { useMemo } from "react";
import {
  describeConditionalTag,
  evaluatePromptTokens,
  formatConditionalTag,
  resolveTemplates,
  Template,
  ColorGradient,
  PromptValues,
} from "@pixerate/editor";

export interface TemplateRendererProps {
  /** Raw prompt or text string to render */
  content: string;
  /** Available templates for recursive resolution and custom coloring */
  templates?: Template[];
  /** Custom gradient color map for templates */
  templateColorMap?: Map<string, ColorGradient>;
  /** Whether to resolve nested templates recursively before displaying */
  resolve?: boolean;
  /** Template version bindings used when `resolve` is set */
  bindings?: Record<string, string>;
  /**
   * Variable values. When set, variables show their value (or default),
   * sections whose condition fails are hidden, and section tags are dropped.
   */
  values?: PromptValues;
  /** Custom class name for the wrapper */
  className?: string;
  /** Click callback for template badges */
  onTemplateClick?: (templateName: string) => void;
  /** Click callback for variable badges */
  onVariableClick?: (variableName: string) => void;
}


export const TemplateRenderer: React.FC<TemplateRendererProps> = ({
  content,
  templates = [],
  templateColorMap,
  resolve = false,
  bindings,
  values,
  className = "font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
  onTemplateClick,
  onVariableClick,
}) => {
  const displayText = useMemo(() => {
    if (!resolve || templates.length === 0) return content;
    return resolveTemplates(content, templates, { bindings });
  }, [content, templates, resolve, bindings]);

  const tokens = useMemo(() => {
    return evaluatePromptTokens(displayText, values);
  }, [displayText, values]);

  return (
    <div className={className}>
      {tokens.map((token, index) => {
        if (token.type === "template") {
          const colors = templateColorMap?.get(token.value) || {
            from: "#f43f5e",
            to: "#8b5cf6",
          };
          const style = {
            "--color-from": colors.from,
            "--color-to": colors.to,
          } as React.CSSProperties;

          return (
            <span
              key={index}
              style={style}
              onClick={() => onTemplateClick?.(token.value)}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-semibold rounded-md border border-[var(--color-to)]/40 bg-gradient-to-r from-[var(--color-from)]/15 to-[var(--color-to)]/15 text-[var(--color-to)] hover:brightness-110 cursor-pointer transition-all"
              title={`Template: ${token.value}`}
            >
              {`{{${token.value}}}`}
            </span>
          );
        }

        if (token.type === "variable") {
          const details = [
            `Variable: ${token.value}`,
            token.description,
            token.defaultValue !== undefined
              ? `Default: ${token.defaultValue || "(empty)"}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n");

          if (token.resolvedValue !== undefined) {
            return (
              <span
                key={index}
                onClick={() => onVariableClick?.(token.value)}
                data-variable={token.value}
                data-value-source={token.valueSource}
                className={
                  token.valueSource === "value"
                    ? "inline px-1 mx-0.5 rounded-md bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-b border-emerald-400/60 cursor-pointer"
                    : "inline px-1 mx-0.5 rounded-md bg-violet-400/10 text-violet-600 dark:text-violet-300 italic border-b border-dashed border-violet-400/60 cursor-pointer"
                }
                title={details}
              >
                {token.resolvedValue}
              </span>
            );
          }

          return (
            <span
              key={index}
              onClick={() => onVariableClick?.(token.value)}
              data-variable={token.value}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-violet-400/40 bg-violet-400/15 text-violet-600 dark:text-violet-300 hover:brightness-110 cursor-pointer transition-all"
              title={details}
            >
              {`{${token.value}`}
              {token.defaultValue !== undefined && (
                <span className="opacity-60">{`|${token.defaultValue}`}</span>
              )}
              {"}"}
            </span>
          );
        }

        if (token.type === "conditional" && token.conditional) {
          return (
            <span
              key={index}
              data-conditional={token.conditional}
              className="inline-flex items-center px-1 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-amber-400/40 bg-amber-400/15 text-amber-700 dark:text-amber-300"
              title={describeConditionalTag(token)}
            >
              {formatConditionalTag(token)}
            </span>
          );
        }

        if (token.type === "instruction") {
          return (
            <span
              key={index}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs italic font-medium rounded-md border border-rose-400/40 bg-rose-400/15 text-rose-600 dark:text-rose-300"
              title={`Instruction: ${token.value}`}
            >
              {`__${token.value}__`}
            </span>
          );
        }

        return <span key={index}>{token.value}</span>;
      })}
    </div>
  );
};
