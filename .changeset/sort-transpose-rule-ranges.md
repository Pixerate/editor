---
'@pixerate/editor': patch
---

Spreadsheet sort and transpose now move conditional formats and data validations with the cells, as Excel does: rule parts covering only some of the sorted rows follow their rows (formulas re-anchored), rule parts spanning every sorted row stay with the column, and transposing transposes rule ranges and their formula references. Both are part of the sort/transpose undo step. Adds `sortRuleRanges`, `transposeRuleRanges`, `mergeRuleRanges`, `sortRules`, `transposeRules`, `reanchorRuleFormula`, `transposeRuleFormula`, `mapConditionalFormatFormulas`, `mapDataValidationFormulas` and `transposeFormulaReferences`.
