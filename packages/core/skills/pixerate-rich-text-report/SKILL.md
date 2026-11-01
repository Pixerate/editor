---
name: pixerate-rich-text-report
description: The report and structured document workflow in the Pixerate rich text editor - outlining before writing, one title and a heading hierarchy, consistent heading case, short paragraphs, lists for steps and items, tables for comparisons, charts in the document, and a final read-through for structure and consistency. Use when asked to write, structure, format, outline or tidy a report, memo, proposal, brief, article, documentation page or meeting notes, add headings, lists or a table, or make a document consistent, or when get_text, set_block_type, edit_table or insert_chart are available. Load with pixerate-rich-text, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-rich-text
---

# Structuring a report

A report is read by skimming first: the title, the headings and the first lines decide whether
anyone reads the rest. So the structure carries the message: one title, sections with headings
one level below, steps and items as lists, comparisons as tables, figures as charts. Get the
structure right, then the words, then check consistency.

This skill is the method. `pixerate-rich-text` has the full tool reference; positions come from
`get_text` with `blocks: true` or from `find_text`, never from counting characters.

## Goal and quality bar

- One `heading` level 1 for the title; sections at level 2, subsections at level 3; no skipped
  levels.
- Headings consistent in case (sentence case unless the house style says otherwise) and short.
- Steps as an ordered list, items as a bulleted list; comparisons with more than two attributes
  as a table with a header row; numbers that show a trend as a chart.
- Short paragraphs, each with one point; the summary first.
- Nothing the author wrote is lost unless they asked for it to go.

## Inputs to confirm

- **Purpose and reader:** what decision or knowledge the document serves.
- **Sections** the user expects, or a template.
- **House style:** heading case, numbering, how dates and numbers are written.

## Working method

1. **Read.** `get_text` with `blocks: true`: every block's `type`, `from`, `to` and `text`.
   **Check:** you can name the title, the sections and the body of each.
2. **Outline.** Decide the heading hierarchy and which runs of paragraphs are really lists or
   tables before changing anything.
3. **Set the structure** with `set_block_type` on each block's range: `heading` with `level`,
   `"bullet_list"`, `"ordered_list"`. Work from the blocks you read; positions shift when block types
   change, so re-read (`get_text` `blocks`) after changes that add or remove wrapping.
   **Check:** `get_text` `format: "html"` shows `<h1>`, `<h2>`, `<ul>` where you meant.
4. **Tables.** `edit_table` `insertTable` (`at` the end of the paragraph it follows, `rows`,
   `cols`, `withHeaderRow`), then `insert_text` into each cell from the last cell to the first so
   earlier positions stay valid (cell positions from `get_text` `blocks`).
   **Check:** the HTML has the header cells and rows in order.
5. **Charts** for figures: `insert_chart` with the data; edit with `update_chart_in_document`.
6. **Consistency pass.** Heading case, terms, numbers and dates written one way:
   `find_text` to find variants, `replace_text` to fix them (see
   `pixerate-rich-text-revise`).
   **Check:** `find_text` for the old variants returns no matches.
7. **Read it through** once as the reader would (`get_text`), and report what changed.

## Decision table

| Content | Block |
| --- | --- |
| Document title | `heading` level 1 (once) |
| Section, subsection | `heading` level 2, 3 |
| Steps in order | `"ordered_list"` |
| Items, options, takeaways | `"bullet_list"` |
| Things compared on several attributes | A table with a header row |
| A trend or comparison of numbers | `insert_chart` |
| A quotation | `blockquote` |
| Code or commands | `"code_block"` |

## Recipes

**Structure a draft.** `get_text` `blocks` → `set_block_type` title `heading` level 1 → each
section line `heading` level 2 → each run of item lines `"bullet_list"` (one call over the run's
range).

**A two-column table.** `edit_table` `{ operation: "insertTable", at, rows: 3, cols: 2,
withHeaderRow: true }` → `get_text` `blocks` for the empty cells → `insert_text` into each cell,
last first.

## Pitfalls

- **Positions from the plain text** are wrong: block boundaries count. Use `blocks` or
  `find_text`.
- **Stale positions** after a change that adds a list or table; re-read before the next edit.
- **Several level-1 headings** flatten the outline; one title only.
- **Bold paragraphs as headings** do not appear in the outline or navigation; use headings.
- **Tables for prose** or one-column tables; use paragraphs or lists.
- **Rewriting the author's words** while restructuring; change structure, not content, unless
  asked.

## Tools used

- `get_text`, `find_text`: read the document, its blocks and positions
- `set_block_type`, `set_text_align`: headings, lists and alignment
- `format_text`: emphasis and links
- `edit_table`: insert and shape tables
- `insert_text`, `replace_range`, `replace_text`: fill cells, write and fix text
- `insert_chart`, `update_chart_in_document`, `list_document_charts`: charts in the document
- `undo_rich_text`: take back a step
