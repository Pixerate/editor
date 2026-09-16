import {
  Markdown as TipTapMarkdown,
  type MarkdownOptions as TipTapMarkdownOptions,
} from "tiptap-markdown";

const resolveExt = (mod: any, name: string) =>
  mod?.[name] ||
  mod?.default?.[name] ||
  mod?.default?.default ||
  mod?.default ||
  mod;

/**
 * Built-in native Markdown extension for @pixerate/editor based on tiptap-markdown.
 * Enables automatic markdown parsing, serialization, and clipboard handling.
 */
export const Markdown = resolveExt(TipTapMarkdown, "Markdown");

export type { TipTapMarkdownOptions as MarkdownOptions };
