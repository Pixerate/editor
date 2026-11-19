---
"@pixerate/editor": patch
"@pixerate/swift": minor
---

House style on Markdown text in Swift (#890): `PixerateMarkdown` ports the TS Markdown reader (`markdownProseMap`, `markdownStyleState`, `narrowMarkdownStyleTarget`, `markdownStyleEdits`, `applyMarkdownStyleEdits`) with `JSRegExp` for JavaScript-compatible patterns, and `PixerateMarkdownTools` ports the rich-text checks (`richTextStyleChecks`, `applyTextCase`, `richTextHouseStyle`, `checkMarkdownStyle`) and `createMarkdownStyleToolProvider` (`check_rich_text_style`, `fix_rich_text_style`). They reproduce every case of `domains/markdown-style`.

The TS core fixes three bugs in Markdown house style that the new contract cases found: a setext heading's underline no longer reads as an atom, a heading that starts with a code span no longer gets U+FFFC written into it by its fix, and an insertion right after a replacement (a list item's full stop after a closing quote) is no longer left for a second run.
