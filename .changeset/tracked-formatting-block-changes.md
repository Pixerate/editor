---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Track formatting, block-structure and code-block edits in suggestion mode.

- Core: `TrackChanges` now records formatting changes on existing text (mark added/removed/changed, e.g. bold, links, highlight, font size) with a `formatChange` mark holding the author, id and the `before` / `after` formatting, and textblock changes (paragraph ↔ heading, heading level, code block, alignment, list wrap/lift/indent/outdent, list type, blockquote) with a `blockChange` node attribute holding the previous type, attributes and wrappers. Accept/reject (single and all) handle every kind as one undo step; reject restores the previous formatting, type and nesting. Insertions and deletions inside code blocks are tracked as well. New options `trackFormatting`, `trackBlocks`, `trackCodeBlocks`, `blockTypes`, `ignoredMarks`, `ignoredBlockAttributes`, `formatChangeHTMLAttributes` and `blockChangeClass`.
- `TrackedChange.type` adds `"format"` and `"block"`; every change has a human-readable `description` ("Formatted: Bold", "Changed Paragraph to Heading 2"), plus `format` / `block` details. New exports: `TrackedFormatChange`, `FORMAT_CHANGE_MARK_NAME`, `BLOCK_CHANGE_ATTRIBUTE`, `describeFormatChange`, `describeBlockChange` and the related types.
- Serializers export the new formatting and block types by default and the original ones with `trackedChanges: "original"`. Pasted content drops format and block records.
- React / Svelte: `ReviewToolbar` shows the current change's author and description (`showDescription`, `descriptionClassName` / `descriptionClass`).
