import { Mark } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { TEMPLATE_REGEX, VARIABLE_REGEX, INSTRUCTION_REGEX, ColorGradient } from "../grammar/tokens";

export interface GradientTextOptions {
  templateColorMap: Map<string, ColorGradient>;
  speed?: number;
  jsonVariables?: string[] | Set<string>;
  onTemplateClick?: (templateName: string, event: MouseEvent) => void;
}

const createGradientDecorations = (
  doc: ProsemirrorNode,
  options: GradientTextOptions,
): Decoration[] => {
  const decorations: Decoration[] = [];
  const speed = options.speed ?? 1;
  const jsonVarSet = options.jsonVariables
    ? options.jsonVariables instanceof Set
      ? options.jsonVariables
      : new Set(options.jsonVariables)
    : null;

  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text || "";
      let match: RegExpExecArray | null;

      // 1. Template: {{templateName}}
      const tmplRegex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);
      while ((match = tmplRegex.exec(text)) !== null) {
        const templateName = match[1].trim();
        const colors = options.templateColorMap?.get(templateName);

        if (colors) {
          const start = pos + match.index;
          const end = start + match[0].length;
          const { from: colorFrom, to: colorTo } = colors;

          const style = `--bg-size: ${
            speed * 300
          }%; --color-from: ${colorFrom}; --color-to: ${colorTo}; caret-color: #111 !important; background-image: linear-gradient(to right, ${colorFrom}, ${colorTo}, ${colorFrom}); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent;`;

          decorations.push(
            Decoration.inline(start, end, {
              class:
                "inline animate-gradient bg-gradient-to-r from-[var(--color-from)] via-[var(--color-to)] to-[var(--color-from)] bg-[length:var(--bg-size)_100%] bg-clip-text text-transparent border border-(--color-to)/20 px-1 py-0.5 rounded-sm cursor-pointer",
              style,
              "data-template": templateName,
            }),
          );
        }
      }

      // 2. Instruction: __text__
      const instRegex = new RegExp(
        INSTRUCTION_REGEX.source,
        INSTRUCTION_REGEX.flags,
      );
      while ((match = instRegex.exec(text)) !== null) {
        const content = match[1].trim();
        const colors = options.templateColorMap?.get(content) || {
          from: "#ffaa40",
          to: "#9c40ff",
        };

        const start = pos + match.index;
        const end = start + match[0].length;
        const { from: colorFrom, to: colorTo } = colors;

        const style = `--bg-size: ${
          speed * 300
        }%; --color-from: ${colorFrom}; --color-to: ${colorTo}; caret-color: #111 !important; background-image: linear-gradient(to right, #fb7185, #8b5cf6, #fb7185); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent;`;

        decorations.push(
          Decoration.inline(start, end, {
            class:
              "italic animate-gradient bg-gradient-to-r from-rose-400 from-50% to-violet-500 to-50% bg-size-[200%_100%] bg-clip-text text-transparent inline-flex items-baseline gap-0.5",
            style,
          }),
        );
      }

      // 3. Variable: {variableName}
      const varRegex = new RegExp(
        VARIABLE_REGEX.source,
        VARIABLE_REGEX.flags,
      );
      while ((match = varRegex.exec(text)) !== null) {
        const variableName = match[1].trim();
        const start = pos + match.index;
        const end = start + match[0].length;
        const isJsonVar = jsonVarSet?.has(variableName);

        decorations.push(
          Decoration.inline(start, end, {
            class: isJsonVar
              ? "bg-violet-400/40 border-b-4 border-rose-300 dark:border-rose-800 inline-flex items-baseline px-1 py-0 text-foreground/80 gap-0.5 rounded-xs"
              : "bg-rose-400/40 border-b-4 border-violet-300 dark:border-violet-800 inline-flex items-baseline px-1 py-0 text-foreground/80 gap-0.5 rounded-xs",
            "data-variable": variableName,
          }),
        );
      }
    }
  });

  return decorations;
};

export const GradientText = Mark.create<GradientTextOptions>({
  name: "gradientText",

  addOptions() {
    return {
      templateColorMap: new Map(),
      speed: 1,
      jsonVariables: undefined,
      onTemplateClick: undefined,
    };
  },

  renderHTML({ HTMLAttributes }) {
    const defaultColors = {
      from: "#ffaa40",
      to: "#9c40ff",
    };
    const speed = this.options.speed ?? 1;
    const style = `--bg-size: ${speed * 300}%; --color-from: ${
      defaultColors.from
    }; --color-to: ${defaultColors.to}; caret-color: #111 !important;`;

    return [
      "span",
      {
        class:
          "inline animate-gradient bg-gradient-to-r from-[var(--color-from)] via-[var(--color-to)] to-[var(--color-from)] bg-[length:var(--bg-size)_100%] bg-clip-text text-transparent",
        style,
        ...HTMLAttributes,
      },
      0,
    ];
  },

  parseHTML() {
    return [
      {
        tag: "span",
        getAttrs: (node) =>
          (node as HTMLElement).classList.contains("animate-gradient") &&
          (node as HTMLElement).classList.contains("bg-clip-text") &&
          null,
      },
    ];
  },

  addProseMirrorPlugins() {
    const markOptions = this.options;

    return [
      new Plugin({
        state: {
          init(_, { doc }) {
            return DecorationSet.create(
              doc,
              createGradientDecorations(doc, markOptions),
            );
          },
          apply(tr, value: DecorationSet) {
            const newDoc = tr.doc;
            if (tr.docChanged) {
              return DecorationSet.create(
                newDoc,
                createGradientDecorations(newDoc, markOptions),
              );
            }
            return value.map(tr.mapping, newDoc);
          },
        },
        props: {
          decorations(state: EditorState) {
            return (this as any).getState(state) as DecorationSet;
          },
          handleClickOn(view, pos, _node, _nodePos, event) {
            const decorationSet = (this as any).getState(
              view.state,
            ) as DecorationSet;
            const decorations = decorationSet.find(pos, pos + 1);

            for (const decoration of decorations) {
              const decorationWithAttrs = decoration as any;
              const templateName =
                decorationWithAttrs.type?.attrs?.["data-template"];
              if (templateName) {
                if (markOptions.onTemplateClick) {
                  markOptions.onTemplateClick(templateName, event as MouseEvent);
                }
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("show-gradient-popover", {
                      detail: {
                        templateName,
                        target: event.target,
                      },
                    }),
                  );
                }
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});
