---
"@pixerate/editor": minor
---

Spreadsheet CSV/TSV import adapters for the import registry (`csvImportAdapter`, `tsvImportAdapter`, `registerSpreadsheetImportAdapters`, `importFileIntoSpreadsheet`) and `SpreadsheetController#importRows`. Fixes generated row/column/filter ids colliding when many rows are created in the same millisecond, which made large imports share cell storage and report false `#CYCLE!` errors.
