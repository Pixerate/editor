---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
---

Add built-in optional Markdown support, serializers, and controller synchronization:
- Export `Markdown` extension and `MarkdownOptions` configuration in `@pixerate/editor`.
- Add `markdown?: MarkdownOptions | boolean` to `createRichTextPreset`.
- Export `markdownToTipTapHtml` and `getEditorMarkdown` from `@pixerate/editor/serializers`.
- Add `markdownMode`, `getMarkdown()`, `setMarkdown()`, and `onMarkdownChange` to `EditorController`.
- Expose `markdown` and `richTextOptions` in `EditableTextNodeEditor` in `@pixerate/editor-svelte`.
