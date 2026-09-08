import { wrappingInputRule, markInputRule, type Extensions } from "@tiptap/core";
import * as _StarterKit from "@tiptap/starter-kit";
import * as _Color from "@tiptap/extension-color";
import * as _Highlight from "@tiptap/extension-highlight";
import * as _Link from "@tiptap/extension-link";
import * as _TaskList from "@tiptap/extension-task-list";
import * as _TaskItem from "@tiptap/extension-task-item";
import * as _TextAlign from "@tiptap/extension-text-align";
import * as _TextStyle from "@tiptap/extension-text-style";
import * as _Typography from "@tiptap/extension-typography";
import * as _Underline from "@tiptap/extension-underline";
import * as _Placeholder from "@tiptap/extension-placeholder";
import * as _CharacterCount from "@tiptap/extension-character-count";

const resolveExt = (mod: any, name: string) =>
  mod?.[name] || mod?.default?.[name] || mod?.default?.default || mod?.default || mod;

const StarterKit = resolveExt(_StarterKit, "StarterKit");
const Color = resolveExt(_Color, "Color");
const Highlight = resolveExt(_Highlight, "Highlight");
const Link = resolveExt(_Link, "Link");
const TaskList = resolveExt(_TaskList, "TaskList");
const TaskItem = resolveExt(_TaskItem, "TaskItem");
const TextAlign = resolveExt(_TextAlign, "TextAlign");
const TextStyle = resolveExt(_TextStyle, "TextStyle");
const Typography = resolveExt(_Typography, "Typography");
const Underline = resolveExt(_Underline, "Underline");
const Placeholder = resolveExt(_Placeholder, "Placeholder");
const CharacterCount = resolveExt(_CharacterCount, "CharacterCount");

import { SmilieReplacer } from "./SmilieReplacer";
import { ColorHighlighter } from "./ColorHighlighter";
import { FontSize } from "./FontSize";
import { Mention, type MentionOptions } from "./mention";

export interface RichTextPresetOptions {
  placeholder?: string | ((props: { node: any }) => string);
  characterLimit?: number;
  openLinksOnClick?: boolean;
  enableSmilies?: boolean;
  enableColorHighlighter?: boolean;
  headingLevels?: (1 | 2 | 3 | 4 | 5 | 6)[];
  mention?: MentionOptions | boolean;
}

/**
 * Creates a standard rich-text extensions bundle with full formatting support.
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
    Link.extend({
      addInputRules() {
        return [
          markInputRule({
            find: /(?:^|\s)\[([^\]]+)\]\(([^)]+)\)$/,
            type: this.type,
            getAttributes: (match) => ({
              href: match[2],
            }),
          }),
        ];
      },
    }).configure({
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
    TaskItem.extend({
      addInputRules() {
        return [
          wrappingInputRule({
            find: /^\s*(\[([ |x])?\])\s$/i,
            type: this.type,
            getAttributes: (match) => ({
              checked: match[2]?.toLowerCase() === "x",
            }),
          }),
        ];
      },
    }).configure({
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

  if (options.mention) {
    const mentionConfig = typeof options.mention === "object" ? options.mention : {};
    extensions.push(
      Mention.configure({
        HTMLAttributes: {
          class: "pixerate-mention-node",
          ...(mentionConfig.HTMLAttributes || {}),
        },
        ...mentionConfig,
      }),
    );
  }

  return extensions;
}
