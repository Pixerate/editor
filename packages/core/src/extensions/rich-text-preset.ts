import {
  wrappingInputRule,
  markInputRule,
  type Extensions,
} from "@tiptap/core";
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
  mod?.[name] ||
  mod?.default?.[name] ||
  mod?.default?.default ||
  mod?.default ||
  mod;

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
import { Markdown, type MarkdownOptions } from "./markdown";
import { Image, type ImageOptions } from "./image";
import { Comments, type CommentsOptions } from "./comments";
import { TrackChanges, type TrackChangesOptions } from "./track-changes";
import { DocumentCompare } from "./document-compare";
import { FileImport, type FileImportOptions } from "./file-import";
import { RichClipboard, type RichClipboardOptions } from "./rich-clipboard";
import { Autocorrect, type AutocorrectOptions } from "./autocorrect";
import {
  Outline,
  TableOfContents,
  FootnoteReference,
  Footnotes,
  Footnote,
  Bookmark,
  CrossReference,
  type OutlineOptions,
  type TableOfContentsOptions,
  type FootnotesOptions,
  type BookmarkOptions,
  type CrossReferenceOptions,
} from "./document-structure";
import { FindReplace, type FindReplaceOptions } from "./find-replace/extension";

export interface RichTextPresetOptions {
  placeholder?: string | ((props: { node: any }) => string);
  characterLimit?: number;
  openLinksOnClick?: boolean;
  enableSmilies?: boolean;
  enableColorHighlighter?: boolean;
  headingLevels?: (1 | 2 | 3 | 4 | 5 | 6)[];
  mention?: MentionOptions | boolean;
  markdown?: MarkdownOptions | boolean;
  image?: ImageOptions | boolean;
  /** Adds the `Comments` extension (off by default). */
  comments?: Partial<CommentsOptions> | boolean;
  /** Adds the `TrackChanges` and `DocumentCompare` extensions (off by default). */
  trackChanges?: Partial<TrackChangesOptions> | boolean;
  /** Import dropped/pasted .md, .html, .txt and .rtf files (opt-in). */
  fileImport?: FileImportOptions | boolean;
  /** Copy/paste lossless ProseMirror slices between editors (opt-in). */
  richClipboard?: RichClipboardOptions | boolean;
  /**
   * Word-style AutoCorrect (smart quotes, symbols, fractions, sentence
   * capitalization, ...). Off by default. Replaces the Typography extension
   * when enabled, since both handle quotes and dashes.
   */
  autocorrect?: Partial<AutocorrectOptions> | boolean;
  /** Heading outline with stable heading ids. Off by default. */
  outline?: Partial<OutlineOptions> | boolean;
  /** Table of contents block (also enables `outline`). Off by default. */
  tableOfContents?: Partial<TableOfContentsOptions> | boolean;
  /** Footnote references and the footnotes list. Off by default. */
  footnotes?: Partial<FootnotesOptions> | boolean;
  /** Named bookmarks. Off by default. */
  bookmarks?: Partial<BookmarkOptions> | boolean;
  /** Cross-references to headings and bookmarks (also enables `outline`). Off by default. */
  crossReferences?: Partial<CrossReferenceOptions> | boolean;
  /** Word-style Find and Replace (Mod+F / Mod+H, match highlights). Off by default. */
  findReplace?: Partial<FindReplaceOptions> | boolean;
}

const optionObject = <T>(value: T | boolean | undefined): T | Record<string, never> =>
  typeof value === "object" && value !== null ? value : {};

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
    ...(options.autocorrect ? [] : [Typography]),
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
      protocols: ["file", "vscode", "cursor"],
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
        typeof placeholder === "function" ? placeholder : () => placeholder,
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
    const mentionConfig =
      typeof options.mention === "object" ? options.mention : {};
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

  if (options.markdown) {
    const markdownConfig =
      typeof options.markdown === "object" ? options.markdown : {};
    extensions.push(
      Markdown.configure({
        html: true,
        tightLists: true,
        tightListClass: "tight",
        bulletListMarker: "-",
        linkify: true,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
        ...markdownConfig,
      }),
    );
  }

  if (options.image !== false) {
    const imageConfig =
      typeof options.image === "object" ? options.image : {};
    extensions.push(
      Image.configure({
        HTMLAttributes: {
          class: "rounded-md max-w-full h-auto my-2",
          ...(imageConfig.HTMLAttributes || {}),
        },
        ...imageConfig,
      }),
    );
  }

  if (options.comments) {
    extensions.push(
      typeof options.comments === "object"
        ? Comments.configure(options.comments)
        : Comments,
    );
  }

  if (options.trackChanges) {
    extensions.push(
      typeof options.trackChanges === "object"
        ? TrackChanges.configure(options.trackChanges)
        : TrackChanges,
      DocumentCompare,
    );
  }

  if (options.fileImport) {
    extensions.push(
      FileImport.configure(
        typeof options.fileImport === "object" ? options.fileImport : {},
      ),
    );
  }

  if (options.richClipboard) {
    extensions.push(
      RichClipboard.configure(
        typeof options.richClipboard === "object" ? options.richClipboard : {},
      ),
    );
  }

  if (options.autocorrect) {
    extensions.push(Autocorrect.configure(optionObject(options.autocorrect)));
  }

  if (options.outline || options.tableOfContents || options.crossReferences) {
    extensions.push(Outline.configure(optionObject(options.outline)));
  }

  if (options.tableOfContents) {
    extensions.push(TableOfContents.configure(optionObject(options.tableOfContents)));
  }

  if (options.footnotes) {
    extensions.push(
      FootnoteReference.configure(optionObject(options.footnotes)),
      Footnotes,
      Footnote,
    );
  }

  if (options.bookmarks) {
    extensions.push(Bookmark.configure(optionObject(options.bookmarks)));
  }

  if (options.crossReferences) {
    extensions.push(CrossReference.configure(optionObject(options.crossReferences)));
  }

  if (options.findReplace) {
    extensions.push(FindReplace.configure(optionObject(options.findReplace)));
  }

  return extensions;
}
