---
"@pixerate/editor": minor
"@pixerate/conformance": minor
"@pixerate/swift": minor
---

Text mechanics checks for Markdown text (#892): the small, certain fixes a writer expects as they type, moved from Swash's writing partner into the editor so every Pixerate editor can use them.

- `textMechanicsEditsAt(text, boundary, options)` (`/tools`): the fixes after a word boundary is typed. Capital I, missing apostrophes (`its`, `id` and `ill` only where a word-class tagger reads them as contractions), sentence capitals, a full stop or question mark at the end of a finished line, `OK`, a comma before a "but" that starts a clause, and spelling from a checker the host supplies. Code, math, HTML, tables, links' addresses and URLs are never changed. A `chat` profile turns the prose-only checks off for Slack. `textMechanicsFindings` checks a whole text as if it had been typed, and `textMechanicsCheckedRange` gives the range being checked.
- `markdownProseMap(source)`: where the prose is in Markdown source.
- `createTextMechanicsToolProvider(host)`: `check_text_mechanics` and, when the text can be edited, `fix_text_mechanics` (one undo step).
- `@pixerate/conformance`: a new `text-mechanics` domain with 80 typing scenarios, checked ranges and whole-text findings, exported by `textMechanicsContracts()` and checked by a core test.
- Swift (`PixerateMarkdown`): `TextMechanics` reproduces every scenario over `MarkdownDocument`, with `naturalLanguageTagger` for Apple's NaturalLanguage tagger.
