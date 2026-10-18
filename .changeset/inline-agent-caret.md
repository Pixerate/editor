---
"@pixerate/editor": minor
---

Agents now edit rich text inline, the way collaborators do in Google Docs. `createRichTextToolProvider` draws the agent's caret, with its name, where its tools read and write. `find_text` and `set_selection` highlight the agent's selection, and edits tint the new text for a moment. With `presence: { typing: true }`, inserted and replacement text is typed out a few characters at a time. It is still one undo step, and it rolls back if the call is cancelled.

`insert_text`, `replace_range` and `replace_selection` now return the new text's `range`. The caret is on by default; pass `presence: false` to turn it off. The new building blocks are `AgentCaret`, `setAgentCaret`, `clearAgentCaret`, `markAgentChanges` and `typeAgentText`.
