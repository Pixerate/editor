---
name: pixerate-rich-text
description: How to read and edit Pixerate rich text documents and prompt editors through agent tools - reading text with document positions (get_text, find_text), minimal-diff edits (replace_range, replace_text, insert_text), formatting (format_text for bold, italic, links and colour; set_block_type for headings, lists and quotes; set_text_align), selections, tables (edit_table and table.* commands), charts and sparklines embedded in a document, find and replace commands, and prompt editing with templates, variables and instructions (prompt_insert_text, prompt_replace_range, prompt_set_variable, get_editor_state, view_editor). Use when asked to write, rewrite, proofread, restructure or format a document, report, note, heading, paragraph or table, to insert a chart or sparkline into text, or to edit an image-generation or LLM prompt with {{template}}, {variable} and __instruction__ tokens.
---

# Editing rich text documents and prompts

There are two text surfaces, each with its own tools:

- **Rich text documents** (a TipTap / ProseMirror editor) use `get_text`, `find_text` and the
  document write tools. Positions are **ProseMirror document positions**, not character
  offsets into the plain text: every block boundary counts (position 1 is already inside the
  first block). Never compute positions from `get_text` content; get them from
  `find_text` matches or from `get_text {blocks: true}` (each paragraph, heading or table cell
  as `{type, from, to, text}`). Charts in a document have ids (from `list_document_charts`).
- **Prompt editors** (a prompt with a variables map, often beside a canvas) use
  `get_editor_state` and the `prompt_*` tools. Positions are host-defined; read them from
  `get_editor_state` (`document.selection`, `document.text`).

Errors, namespacing (`doc-1__find_text`) and `run_commands` batching are covered by the
`pixerate-agent-tools` skill. Chart type, axis and colour choices are covered by
`pixerate-chart`; the same spec fields apply to charts in a document.

## Workflow skills

For these jobs, load the workflow skill too: it has the method, the checks between steps and
the pitfalls, and uses the tools below.

- `pixerate-rich-text-report`: a title and heading hierarchy, lists, tables, charts and a consistency pass.
- `pixerate-rich-text-revise`: proofreading, renaming terms with exceptions, tightening, minimal edits.

## Working method

1. **Read.** `get_text` (`format: "markdown"` shows headings, lists and tables compactly;
   add `blocks: true` when you will edit by position). For a prompt, `get_editor_state` with
   `includeCanvas: false`.
2. **Locate.** `find_text` for each phrase you will change. Use `before` / `after` context to
   pick the right match when a phrase occurs more than once.
3. **Write the smallest change.** `replace_range` on the matched `{from, to}`, or
   `replace_text` with `occurrence` for one known phrase. Rewrite a whole paragraph only when
   most of it changes. Each call is one undo step.
4. **Re-anchor after every write.** Positions after the edit point move. Use the `range`
   returned by the write, or call `find_text` again; never reuse positions read before a
   write that came earlier in the document. When making several position-based edits from
   one read, apply them from the end of the document backwards.
5. **Format.** Write the words first, then format them: `find_text` (or the write's `range`)
   gives the positions for `format_text` (bold, italic, links, colour...), `set_block_type`
   (headings, lists, quotes, code blocks) and `set_text_align`. Never type markdown such as
   `**bold**` or `# Heading`; it is inserted as those characters.
6. **Check.** `get_text` again (or `find_text` for the new wording) and confirm the result.
   For a prompt, `view_editor` shows how tokens render when layout matters.

## Best practices

- **Structure.** One H1 (the title), then H2 / H3 in order without skipping levels. Headings
  are short noun phrases that let a reader scan. Keep paragraphs to one idea, roughly 3 to 5
  sentences. Use a list for three or more parallel items, a numbered list only when order
  matters.
- **Front-load.** Lead each section and paragraph with its point; put caveats after.
- **Plain language.** Prefer short, active sentences and concrete words. Keep terminology
  consistent; a renamed term must be renamed everywhere (`replace_text` with
  `wholeWord: true`, `matchCase: true`).
- **Respect the author.** Preserve the existing voice, spelling variant and formatting.
  `replace_text` keeps the found text's formatting; `replace_range` inserts plain text, so use
  it for changes inside a run, not across differently formatted spans you want to keep.
- **Accessible tables.** Use tables for data with rows and columns, not for layout. Always
  give a header row (`withHeaderRow: true`, the default), and a header column when the first
  column labels rows. Avoid merged cells: they break reading order for screen readers and
  make data hard to reuse. Keep cell text short; align numbers right
  (`setCellAlignment` with `align: "right"`). Do not rely on cell colour alone to carry
  meaning.
- **Charts in text.** Introduce a chart in the sentence before it and state the takeaway in
  its title ("Revenue doubled in Q3", not "Revenue"). Use a sparkline for a trend inside a
  sentence or table cell and give it a `label` that says what it shows.
- **Prompt hygiene.** Put everything that changes between runs in a `{variable}` and set it
  with `prompt_set_variable` rather than editing the text. Give variables descriptive
  snake_case names and, where useful, a default and a description:
  `{subject|a red fox|Describe the main subject}`. Reuse shared phrasing as a `{{template}}`
  instead of pasting it. Use `{?name}...{/name}` (kept when `name` is set) and
  `{!name}...{/name}` (kept when unset) for optional clauses. Keep `__instruction__` tokens
  short and imperative (`__no text in image__`). State subject, then setting, then style,
  then constraints.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_text` | Read the document. `format`: `text` (default), `html` or `markdown`. `blocks: true` adds every textblock with `{type, from, to, text}` positions. Also returns the selection and document `size`. Call first. |
| `find_text` | Get positions of a phrase: returns `{total, truncated, matches: [{from, to, text, before, after}]}`. Literal by default; `matchCase`, `wholeWord`, `regex` (JavaScript syntax) default false; `maxResults` default 50 (max 500). Feed matches to `replace_range`, `insert_text` `at` or `set_selection`. |
| `list_document_charts` | List charts in document order (id, `pos`, type, title, categories, series ids and names, width, height, a plain-language description) and inline sparklines (pos, kind, values). `includeSpec: true` adds each full spec. Call before `update_chart_in_document`. |
| `get_editor_state` | Read a prompt editor: `document` (`text`, `variables`, `selection`, `isDirty`) and, when a canvas is attached, its nodes and edges. Pass `includeCanvas: false` when you only need the prompt. Positions for the `prompt_*` tools come from here. |
| `view_editor` | Capture an image of the editor (`scope`: `viewport` default or `canvas`; `format`: `jpeg` default or `png`; `maxEdge` default 1024 px). Use once after a batch of edits to check how tokens, tables or charts render; images cost tokens. Only present when the host supports capture. |

### Write

| Tool | Use it to |
| --- | --- |
| `replace_range` | Replace the content between `from` and `to` with literal `text` (newlines start new paragraphs). `from === to` inserts; empty `text` deletes. Returns the new `range` and document `size`. The default tool for minimal-diff edits. |
| `replace_text` | Find and replace a phrase in one undo step, keeping the found text's formatting. Replaces all matches unless `occurrence` (1-based) is given. Same `matchCase` / `wholeWord` / `regex` flags as `find_text`. Fails when nothing matches. Returns `{replaced, total, ranges}`. |
| `insert_text` | Insert literal `text` at `at` (a document position) or at the cursor. Returns the inserted `range`. Use for new sentences or paragraphs; position from `get_text {blocks: true}` (a block's `to` appends to it). |
| `replace_selection` | Replace the current selection with literal text (empty string deletes). Use after `set_selection`, or when the user asks to change what they selected. |
| `format_text` | Set or clear inline formatting on `from`..`to` (or the selection when both are omitted): `bold`, `italic`, `underline`, `strike`, `code` (true sets, false clears), `link` (a URL, or null to remove), `highlight` and `color` (CSS colours, or null), `fontSize` (e.g. `"18px"`, or null). Only the properties you pass change; the schema decides which exist. One undo step; the user's selection stays put. Returns the `range`, its `text` and the `formatting` now on it (`partly` / `mixed` where only some of the text has it). Position from `find_text`. |
| `set_block_type` | Make every block the range touches (or the one at the cursor) a `paragraph`, `heading` (with `level`, 1 to 4 by default), `bullet_list`, `ordered_list`, `task_list`, `blockquote` or `code_block`. Blocks leave any list or quote first, so one call switches a bulleted list to a numbered one; `paragraph` takes them out of lists and quotes. Returns the resulting `blocks` (type, positions, text, level, align, the list or quote they are `in`). |
| `set_text_align` | Align every paragraph and heading the range touches: `left`, `center`, `right`, `justify`, or null for the default. Returns the `blocks` with their `align`. Table cells are aligned with `edit_table` `setCellAlignment` instead. |
| `set_selection` | Select `from`..`to` (or place the cursor when `to` is omitted). Use to show the user a passage, or to aim `edit_table` and the `table.*` commands at a cell. |
| `edit_table` | Insert or edit a table. `operation` is one of the `table.*` command names (`insertTable`, `addRowAfter`, `mergeCells`, `setCellAlignment`, ...). `at` moves the cursor first (a position inside a cell). `insertTable` takes `rows` (default 3, max 100), `cols` (default 3, max 50), `withHeaderRow` (default true); `setCellAlignment` takes `align` (left, center, right, justify, null); `setCellBackground` takes `color` (CSS colour or null). Returns the table size and cursor cell. Only present when the schema has tables. |
| `insert_chart` | Insert a chart block at `at` (or the cursor; a position inside a paragraph splits it). `spec` needs `categories` and `series` (`[{name, values}]`, one value per category) and takes the chart presentation fields (`type`, `title`, axes, legend, `stacking`, `palette`, ...). `width` px or null to fill the line (default null), `height` px (default 320). Returns id, pos and stored spec. |
| `update_chart_in_document` | Change one chart by `chartId` or `pos` from `list_document_charts`. `changes` merges into the spec (axes and legend field by field); given `series` replace all series. Also `width` / `height`. All-or-nothing; invalid fields come back as sentences. |
| `insert_sparkline` | Insert a word-sized chart inside a paragraph or cell at `at`. `values` (numbers or null gaps, up to 1000), `kind`: `line` (default), `column` or `win-loss`; `width` default 80 px, `height` default 18 px; `color`; `label` (accessible text). Fails at a position between blocks. |
| `prompt_insert_text` | Insert text into the prompt at `at`, or at the cursor. Write tokens in their plain syntax (`{subject}`, `{{scene}}`, `__instruction__`). |
| `prompt_replace_range` | Replace prompt text between `from` and `to` (from `get_editor_state`); empty `text` deletes. `from` must not be after `to`. |
| `prompt_set_variable` | Set the value of a template variable (`name` without braces, `value` any JSON value). Prefer this over editing the prompt text when only a slot's value changes. |
| `prompt_select` | Select prompt text between two positions (`from === to` places the cursor), e.g. to show the user what you changed. |

### Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). A rich text document is the editor's ProseMirror JSON (`{ "type": "doc", "content": [...] }`), with marks such as tracked changes and comment anchors; comment threads stay in their own store.

| Tool | Use |
| --- | --- |
| `get_rich_text_document` | Take a copy of the whole document as `{ kind, formatVersion, revision, document }` before a risky rewrite, or to hand it on. To read the document, use `get_text`: it is smaller and says more. Refuses very large documents. |
| `load_rich_text_document` | Put back a copy from `get_rich_text_document` (its `document`, or the whole result). Checked first: when anything is wrong nothing changes and the error says what. One undo step (`undo_rich_text` brings the previous document back). Refused while the document is read-only. To change text use `replace_range`, `replace_text` or `insert_text`: they keep formatting and comments. |
| `undo_rich_text` | Undo the last document edit (one tool call or one user gesture). Returns `undone` (the step's name, when it has one) and whether more can be undone. Fails with "Nothing to undo." when there is nothing. |
| `redo_rich_text` | Redo the last undone document edit. |
| `save_rich_text_document` | Save the document under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_rich_text_documents` | List saved documents (`key`, `name`, `savedAt`), newest first. |
| `open_saved_rich_text_document` | Replace the document with a saved one by `key`. One undo step. Ask before opening over changes the user has not saved. |

## Commands

Run with `run_command` / `run_commands` when the host registers them. Check
`list_commands {enabledOnly: true}` first: table commands are disabled outside a table.

| Command | Use it to |
| --- | --- |
| `findReplace.open` | Show the find bar to the user. |
| `findReplace.openReplace` | Show the find bar with the replace field. |
| `findReplace.find` | Search with Word-style options and get `{count, truncated, matches}` (up to 200). `query` accepts Word `^` codes (`^p` paragraph mark, `^t` tab, `^#` digit) unless `literal: true`; also `matchCase`, `wholeWord`, `matchPrefix`, `matchSuffix`, `ignorePunctuation`, `ignoreWhitespace`, `wildcards`, `regex`. Prefer `find_text` when you only need positions. |
| `findReplace.next` | Move to and select the next match of the current search. |
| `findReplace.previous` | Move to and select the previous match. |
| `findReplace.replaceAll` | Replace every match in one undo step (tracked when Track Changes is on). Same options as `findReplace.find` plus `replacement` (`^&` is the found text; with `wildcards`, `\1`-`\9` are groups). Returns `{replaced}`. Use over `replace_text` when you need Word-style matching. |
| `table.insertTable` | Insert a table at the cursor (`rows`, `cols`, `withHeaderRow`). Same as `edit_table` `insertTable`. |
| `table.addRowBefore` | Add a row above the cursor row. |
| `table.addRowAfter` | Add a row below the cursor row. |
| `table.deleteRow` | Delete the selected rows. |
| `table.addColumnBefore` | Add a column left of the cursor column. |
| `table.addColumnAfter` | Add a column right of the cursor column. |
| `table.deleteColumn` | Delete the selected columns. |
| `table.deleteTable` | Delete the table around the cursor. |
| `table.mergeCells` | Merge the selected cells. Avoid in data tables. |
| `table.splitCell` | Split a merged cell back into single cells. |
| `table.toggleHeaderRow` | Turn the first row into header cells, or back. |
| `table.toggleHeaderColumn` | Turn the first column into header cells, or back. |
| `table.toggleHeaderCell` | Turn the selected cells into header cells, or back. |
| `table.goToNextCell` | Move the cursor to the next cell. |
| `table.goToPreviousCell` | Move the cursor to the previous cell. |
| `table.setCellAlignment` | Set horizontal alignment of the selected cells (`align`: left, center, right, justify, or null to clear). |
| `table.setCellBackground` | Set the background of the selected cells (`color`: CSS colour, or null to clear). |

## Pitfalls

- **Positions are not string offsets.** `get_text` content index 10 is not document position
  10. Always use positions from `find_text`, `get_text {blocks: true}` or a write's `range`.
- **Stale positions.** Every write shifts later positions. Work back to front, or re-read.
- **Literal text only.** The text tools insert plain text; markdown such as `**bold**` or
  `# Heading` is inserted as those characters. A newline in `text` starts a new paragraph.
  Format with `format_text` and `set_block_type` after writing; create tables with
  `edit_table`, not pipe characters.
- **Formatting a heading.** Headings are already bold in most themes; make a phrase a heading
  with `set_block_type`, not with `format_text` `bold` and a bigger `fontSize`.
- **Inline code.** In most schemas `code: true` removes the other marks on that text, and a
  code block drops all marks.
- **Range limits.** `from` after `to`, or a position beyond the document `size`, is a tool
  error; nothing is applied.
- **Read-only documents** expose only `get_text`, `find_text` and `list_document_charts` (no
  formatting tools). If
  the write tools are missing, the document is read-only; tell the user rather than working
  around it. `edit_table` exists only when tables are enabled, the chart tools only when
  charts are, `insert_sparkline` only when sparklines are.
- **Table targeting.** `edit_table` and the `table.*` commands act on the cell at the cursor.
  Pass `at` (a position inside the target cell, e.g. a cell block's `from` from
  `get_text {blocks: true}`) or call `set_selection` first. Row and column deletes act on the
  selected cells.
- **Regex.** `regex: true` uses JavaScript syntax; an invalid pattern is a tool error. In
  `replace_text` the replacement is literal (no `$1`); use `findReplace.replaceAll` with
  `wildcards` when you need group references.
- **Agent presence.** Hosts may show your caret and type text out gradually; a long insertion
  is still one undo step. Do not issue the next write before the previous call returns.
- **Prompt tokens.** Editing inside a token can break it (`{subj|ect}` changes its default).
  Replace whole tokens, including braces or underscores. A template that includes itself, or nests
  deeper than the resolver's limit, resolves to an error marker rather than text. A literal `|`,
  `{` or `}` inside a variable default must be escaped with a backslash.
- **Prompt writes return only `{applied, steps}`.** Call `get_editor_state` to see the new
  text and selection before a second position-based prompt edit.
