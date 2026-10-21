---
"@pixerate/editor": minor
---

Agents can now format rich text. The rich text tool provider adds `format_text` (set or clear bold, italic, underline, strike, inline code, links, highlight, text colour and font size on a range or the selection), `set_block_type` (paragraph, heading with a level, bulleted, numbered and task lists, quote, code block; one call switches between kinds) and `set_text_align`. Each is listed only for what the editor's schema supports and only while it is editable, applies as one undo step even when calls follow each other quickly, keeps the user's selection, and returns the range with the formatting or blocks it now has.

Fix: `insert_text`, `replace_text`, `replace_range`, `replace_selection` and typed-out agent text are now one undo step per call. Calls that came within half a second of each other used to undo together.
