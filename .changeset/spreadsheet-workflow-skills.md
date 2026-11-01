---
'@pixerate/editor': patch
---

Two new spreadsheet workflow skills, each with evals: `pixerate-spreadsheet-analysis` (summary tables, growth, shares and rankings as live formulas that reconcile with the data) and `pixerate-spreadsheet-financial-model` (inputs apart from calculations, one formula pattern per row, no hard-coded numbers, scenarios and audits). An eval check whose `$expr` throws now counts as not matching instead of failing the run.
