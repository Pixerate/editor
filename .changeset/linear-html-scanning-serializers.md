---
"@pixerate/editor": patch
---

Fix catastrophic regex backtracking on malformed HTML in `extractMentions`, `htmlToPlainText` (Node fallback), `stripMarkdownCode` and tracked-change stripping. Inputs such as thousands of unclosed `<span data-type="mention"` tags could block for minutes; they are now processed in linear time with identical results for well-formed input.
