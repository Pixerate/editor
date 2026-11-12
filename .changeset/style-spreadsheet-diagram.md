---
"@pixerate/editor": minor
---

House style for spreadsheets and diagrams (#779).

- `spreadsheetStyleDomain` (`spreadsheet.json`): header case, the house number format for each kind of value (`numberFormats`), a frozen header, and the brand's palette-only / min-contrast on conditional format colours. Findings target cells in A1 notation with the certain fix. Agent tools `check_spreadsheet_style` and `fix_spreadsheet_style` (one undo step; hidden when read-only), `createSpreadsheetStyleToolProvider`. `SpreadsheetController.batch(fn)` runs several edits as one undo step.
- `diagramStyleDomain` (`diagram.json`): layout direction, label case and length, node count, node shapes, and the brand's palette-only / min-contrast / fonts-allowed on node, group and edge styles. Agent tools `check_diagram_style` and `fix_diagram_style` (label case and direction as one undo step; hidden when the diagram cannot be edited), `createDiagramStyleToolProvider`.
- `applyTextCase` (`/tools`): the sentence / title / upper case helper the rich-text, spreadsheet and diagram styles share (`richTextHeadingCase` is now an alias).
