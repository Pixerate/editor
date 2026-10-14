---
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Fix scrolled rows showing through frozen rows in `SpreadsheetEditor`. The grid table used `border-collapse: collapse`, whose shared row borders are not repainted with sticky (frozen) cells, so thin slivers of the rows scrolling underneath appeared along each frozen row. The table now uses separate borders with zero spacing and draws each row's bottom border on its cells.
