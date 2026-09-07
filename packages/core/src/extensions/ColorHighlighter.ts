import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";

export function findHexColors(doc: ProsemirrorNode): DecorationSet {
  const hexColorRegex = /(#[0-9a-fA-F]{3,8})\b/g;
  const decorations: Decoration[] = [];

  doc.descendants((node, position) => {
    if (!node.text) return;

    let match: RegExpExecArray | null;
    while ((match = hexColorRegex.exec(node.text)) !== null) {
      const color = match[0];
      const from = position + match.index;
      const to = from + color.length;

      decorations.push(
        Decoration.inline(from, to, {
          class: "color-highlight px-1 py-0.5 rounded text-xs font-mono border",
          style: `--color: ${color}; background-color: ${color}20; border-color: ${color}; color: ${color};`,
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const ColorHighlighter = Extension.create({
  name: "colorHighlighter",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init(_, { doc }) {
            return findHexColors(doc);
          },
          apply(transaction, oldState) {
            return transaction.docChanged ? findHexColors(transaction.doc) : oldState;
          },
        },
        props: {
          decorations(state) {
            return (this as any).getState(state);
          },
        },
      }),
    ];
  },
});
