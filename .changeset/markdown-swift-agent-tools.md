---
"@pixerate/swift": minor
"@pixerate/editor": patch
---

PixerateMarkdownTools (#609): agent tools for a Markdown text in Swift with the web Markdown tools' names, schemas and results — `get_text`, `find_text`, `insert_text`, `replace_text`, `replace_range`, `replace_selection`, `set_selection`, `format_text`, `set_block_type`, the manifest's `format.*` commands through `list_commands` / `run_command` / `run_commands`, and `check_text_mechanics` / `fix_text_mechanics` — over a `MarkdownTextHost` (or the in-memory `MarkdownTextBuffer`), ready to register in a `ToolRegistry` and serve through `ToolBridgeClient`. `FormatCommandDefinition` now carries the manifest's `params` schema. The `pixerate-rich-text` skill covers Markdown source editors and their positions.
