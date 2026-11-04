---
"@pixerate/swift": minor
---

Add `PixerateMarkdown`, the Markdown engine shared with Swash (#546), as a Foundation-only library product. It has a CommonMark 0.31.2 + GFM parser with exact source ranges for every node and syntax marker, the HTML renderer, HTML → Markdown paste conversion (on iOS too), the code highlighter, outlines and statistics. It also has the editing engine on raw Markdown: format toggles, links, list continuation, indent / outdent, Backspace and math braces, plus the format-command manifest from `@pixerate/markdown-conformance`. Its tests run the CommonMark and GFM spec examples and the shared Markdown editing corpus.
