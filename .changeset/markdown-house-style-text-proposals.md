---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

House style for Markdown text, a text change feed and text proposals (#890).

- `markdownStyleState(source)` reads the blocks of Markdown source for the document house-style checks, with UTF-16 source offsets and only the prose (never code, math, HTML, tables, front matter, link addresses or syntax). `checkMarkdownStyle` runs them and narrows each certain fix to the words it changes, so emphasis and links keep their syntax; the brand's colour and font checks are reported as skipped. `createMarkdownStyleToolProvider` offers `check_rich_text_style` / `fix_rich_text_style` over a text host (fix is one undo step and refuses on a read-only text). `richTextStyleDomain` is now also exported from `@pixerate/editor/tools`.
- `createTextChangeFeed` reports what changed in a text (range, removed and inserted text), the selection, who made it (`user` or `agent:<id>`), word and line boundaries, and when a typing burst ends.
- `createTextProposals` stages replacements an agent suggests, accepted as one undo step by the proposer or dismissed; they follow the text as the person writes and report how each ended. Agent tools: `propose_text_edit`, `list_text_proposals`, `accept_text_proposal`, `reject_text_proposal` (`createTextProposalToolProvider`).
- React: `useTextProposals`, `useTextChangeFeed`. Svelte: `createTextProposalState`, `createTextChangeWatcher`.
- `richTextBlockPos` takes an `end` flag so a range's end never takes in what lies between two segments.
- `@pixerate/conformance` has a new `markdown-style` domain for the Swift port.
