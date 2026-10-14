---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add document-structure features for the rich-text editor, all opt-in via new `createRichTextPreset` options (`outline`, `tableOfContents`, `footnotes`, `bookmarks`, `crossReferences`, `autocorrect`); existing consumers see no behaviour change.

- **Outline**: `Outline` extension gives headings stable `id` attributes and keeps a heading outline in plugin state (`getOutline`, `buildOutlineTree`, `getActiveHeading`, `createOutlineStore`, `navigateToHeading`, `focusHeading` / `scrollToHeading` commands).
- **Table of contents**: `TableOfContents` atom block with linked entries refreshed on every change, `insertTableOfContents` command, `[[toc]]` markdown round-trip.
- **Footnotes**: `FootnoteReference`, `Footnotes` and `Footnote` nodes with automatic numbering, reordering and pruning; `insertFootnote`, `updateFootnote`, `deleteFootnote`, `goToFootnote`, `goToFootnoteReference` commands; `[^n]` markdown export and import.
- **Bookmarks and cross-references**: `Bookmark` mark (`setBookmark`, `removeBookmark`, `renameBookmark`, `goToBookmark`) and `CrossReference` node that shows its target's current text and a broken state when the target is removed.
- **Autocorrect**: `Autocorrect` extension with a rule registry (smart quotes, symbols, fractions, sentence capitalization, two initial capitals), an exceptions list, Word-like undo of a correction, and no corrections in code or prompt tokens. `SmilieReplacer` is unchanged; its smilies are also available as `smilieAutocorrectRules`.
- `documentStructureCommandItems` / `getDocumentStructureCommandItems` for slash menus and toolbars.
- React: `OutlinePanel` component and `useOutline` hook. Svelte: `OutlinePanel` component and `createOutline` rune.
