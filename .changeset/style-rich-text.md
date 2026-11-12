---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

House style for documents (#778): a `rich-text` style domain (`richTextStyleDomain`, from `@pixerate/editor`).

- `rich-text.json` sets heading case (`sentence`, `title`, `upper`, keeping acronyms, words with digits and `properNouns`), the deepest heading level, list item endings, curly or straight quotes, terms to avoid (with replacements), the thousands separator and the date format. Checks: `heading-case`, `heading-levels`, `list-punctuation`, `quotes`, `terms`, `number-format`, `date-format`, plus the shared `palette-only`, `min-contrast` and `fonts-allowed` on the document's text colours and fonts. A brand gives documents its fonts and palette.
- `richTextStyleState(doc)` reads a ProseMirror document into blocks and styled runs with positions; findings target `{ from, to }` ranges for `replace_range`, with the `replacement` when the fix is certain.
- Agent tools: `check_rich_text_style`, and `fix_rich_text_style`, which applies every certain fix as one undo step (hidden on a read-only document). `createRichTextStyleToolProvider`.
- React and Svelte: `useRichTextStyleFindings(styles, editor, scope?)`; `useStyleFindings` takes an optional `scope`.
