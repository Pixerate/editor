---
"@pixerate/editor": patch
---

Make `preprocessMarkdownMentions` (and so markdown import) linear on malformed input. It split content with `MARKDOWN_MENTION_SPLIT_REGEX`, which is cubic on unclosed mention spans (4,000 repetitions of `<span data-type='mention' ` took 219 s) and quadratic on unclosed fences, `<pre>`/`<code>` and tags. It now uses the new `splitMarkdownMentionParts`, a single forward scan that returns the same parts. One deliberate difference: a quoted `class`/`data-mention` value can no longer run past the tag's first `>`.
