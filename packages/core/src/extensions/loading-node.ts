import { Node, mergeAttributes } from "@tiptap/core";

export const LoadingNode = Node.create({
  name: "loadingNode",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id"),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { "data-id": attributes.id };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="loading"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "loading",
        class: "inline-flex items-center px-1.5 py-0.5 text-xs text-muted-foreground animate-pulse",
      }),
      "⏳",
    ];
  },
});
