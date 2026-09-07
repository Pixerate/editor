import React, { useMemo } from "react";
import {
  tokenizePrompt,
  resolveTemplates,
  Template,
  ColorGradient,
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
  className = "font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
  onTemplateClick,
  onVariableClick,
}) => {
  const displayText = useMemo(() => {
    if (!resolve || templates.length === 0) return content;
    return resolveTemplates(content, templates);
  }, [content, templates, resolve]);

  const tokens = useMemo(() => {
    return tokenizePrompt(displayText);
  }, [displayText]);

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
          return (
            <span
              key={index}
              onClick={() => onVariableClick?.(token.value)}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-violet-400/40 bg-violet-400/15 text-violet-600 dark:text-violet-300 hover:brightness-110 cursor-pointer transition-all"
              title={`Variable: ${token.value}`}
            >
              {`{${token.value}}`}
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
