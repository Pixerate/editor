---
"@pixerate/editor": minor
---

feat(core): add mention parsing, extraction, code-block immunity, and markdown preprocessing

- Add `preprocessMarkdownMentions` to transform raw markdown `@mentions` into TipTap mention node HTML spans before document creation.
- Add strict code-block immunity (`MARKDOWN_MENTION_SPLIT_REGEX` and `stripMarkdownCode`) protecting fenced code blocks (``` and ~~~), inline code (`...`), HTML `<pre>`/`<code>` blocks, markdown links (`[text](url)`), and raw URLs from false-positive mention parsing.
- Add `extractMentions` to extract unique mention handles from text, markdown, or HTML, safely ignoring HTML attributes, URLs, and code blocks.
- Add `parseMentionSegments` to tokenize content into plain text and mention tokens while preserving punctuation boundaries.
- Add `preprocessMarkdownFileLinks` and support `MarkdownToHtmlOptions` (`mentionables`, `preprocessMentions`, `preprocessFileLinks`) in `markdownToTipTapHtml`.
- Enhance `extractMentionsFromDoc` to gracefully fallback to extracting raw mentions when provided plain text or markdown without pre-rendered HTML spans.
