---
"@pixerate/editor": patch
---

Fix plain-text serialization and literal text insertion:

- `htmlToPlainText` (and therefore `getEditorText`, `EditorController.getPlainText`, `onPlainTextChange` and dirty tracking) no longer repeats list items (TipTap renders `<li><p>…</p></li>`) and no longer drops code blocks, blockquote content or other text outside the recognised block tags.
- HTML is now parsed into an inert `<template>` fragment instead of a `<div>` owned by the live document, so `htmlToPlainText` / `extractMentionsFromDoc` on untrusted HTML can no longer trigger `<img onerror>`-style handlers.
- Mention-span normalization no longer backtracks catastrophically on malformed HTML (previously seconds per keystroke on large inputs).
- The Node.js fallback decodes `&amp;` last (so `&amp;lt;` stays `&lt;`), no longer trims leading blank lines, and handles nested list paragraphs.
- `plainTextToTipTapHtml` only passes input through untouched when it is paragraph HTML (starts with `<p>` and ends with `</p>`); plain text that merely contains `<p>` is now escaped.
- `EditorController.insertText`, `insertTextAt` and `replaceRange` now insert text literally (HTML is not parsed) and split paragraphs on newlines.
