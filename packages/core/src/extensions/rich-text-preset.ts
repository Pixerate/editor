import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";

import { SmilieReplacer } from "./SmilieReplacer";
import { ColorHighlighter } from "./ColorHighlighter";
import { FontSize } from "./FontSize";

export interface RichTextPresetOptions {
  placeholder?: string | ((props: { node: any }) => string);
  characterLimit?: number;
  openLinksOnClick?: boolean;
  enableSmilies?: boolean;
  enableColorHighlighter?: boolean;
  headingLevels?: (1 | 2 | 3 | 4 | 5 | 6)[];
}

/**
 * Creates a standard rich-text extensions bundle with Gleamforge and SlopMachine compatibility.
 */
export function createRichTextPreset(
  options: RichTextPresetOptions = {},
): Extensions {
  const {
    placeholder = "Start typing...",
    characterLimit,
    openLinksOnClick = false,
    enableSmilies = true,
    enableColorHighlighter = true,
    headingLevels = [1, 2, 3, 4],
  } = options;

  const extensions: Extensions = [
    StarterKit.configure({
      orderedList: {
        HTMLAttributes: {
          class: "list-decimal pl-4",
        },
      },
      bulletList: {
        HTMLAttributes: {
          class: "list-disc pl-4",
        },
      },
      heading: {
        levels: headingLevels,
        HTMLAttributes: {
          class: "font-bold tracking-tight",
        },
      },
    }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Underline,
    Typography,
    TextAlign.configure({
      types: ["heading", "paragraph"],
    }),
    Link.configure({
      openOnClick: openLinksOnClick,
      autolink: true,
      defaultProtocol: "https",
      HTMLAttributes: {
        target: "_blank",
        rel: "noopener noreferrer",
        class: "text-blue-500 underline underline-offset-2",
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    FontSize,
    Placeholder.configure({
      emptyEditorClass: "is-empty",
      placeholder:
        typeof placeholder === "function"
          ? placeholder
          : () => placeholder,
    }),
  ];

  if (characterLimit) {
    extensions.push(
      CharacterCount.configure({
        limit: characterLimit,
      }),
    );
  }

  if (enableSmilies) {
    extensions.push(SmilieReplacer);
  }

  if (enableColorHighlighter) {
    extensions.push(ColorHighlighter);
  }

  return extensions;
}
