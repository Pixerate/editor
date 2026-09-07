import { Extension } from "@tiptap/core";
import Suggestion, { SuggestionOptions } from "@tiptap/suggestion";
import { Template } from "../grammar/tokens";

export interface TemplateSuggestionsOptions {
  templates: Template[];
  char?: string;
  onSuggestion?: (props: {
    query: string;
    range: { from: number; to: number };
    clientRect?: (() => DOMRect | null) | null;
    items: Template[];
    command: (props: { name: string }) => void;
  }) => void;
}

export const TemplateSuggestions = Extension.create<TemplateSuggestionsOptions>({
  name: "templateSuggestions",

  addOptions() {
    return {
      templates: [],
      char: "{{",
      onSuggestion: undefined,
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;

    const suggestionConfig: Omit<SuggestionOptions<Template>, "editor"> = {
      char: opts.char || "{{",
      items: ({ query }) => {
        const lower = query.toLowerCase();
        return (opts.templates || []).filter((t) =>
          t.name.toLowerCase().includes(lower),
        );
      },
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent(`{{${props.name}}}`)
          .run();
      },
      render: () => {
        return {
          onStart: (props) => {
            opts.onSuggestion?.(props as any);
          },
          onUpdate: (props) => {
            opts.onSuggestion?.(props as any);
          },
          onExit: () => {
            opts.onSuggestion?.({
              query: "",
              range: { from: 0, to: 0 },
              items: [],
              command: () => {},
            });
          },
        };
      },
    };

    const SuggestionFn =
      typeof Suggestion === "function"
        ? Suggestion
        : (Suggestion as any)?.default || (Suggestion as any)?.Suggestion;

    return [
      SuggestionFn({
        editor: this.editor,
        ...suggestionConfig,
      }),
    ];
  },
});
