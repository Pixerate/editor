---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Mail merge on top of the prompt grammar.

- **Comparison conditions**: `{?amount>100}…{/amount}`, `{?status=paid}…{/status}`, `{!tier<>"gold"}…{/tier}` with `= <> != < > <= >=`, compared numerically when both sides are numbers and as case-insensitive text otherwise. The section is closed by the bare variable name, so existing prompts (including `{?a>1}…{/a>1}`) resolve exactly as before. Malformed comparisons stay literal and are reported as `invalid-condition`. Tokens carry `comparison: { operator, operand }`; new helpers `compareConditionValues`, `parseComparison`, `conditionSubject`, `formatConditionalTag`, `describeConditionalTag`, `parseConditionExpression`, `evaluateConditionExpression`. `extractVariables` flags `usedInComparison`, and such variables are no longer `conditionOnly` form fields. `GradientText` decorates comparisons and flags malformed ones.
- **Data sources**: `parseDataSource(text | rows | objects, { delimiter, hasHeader, format, maxRecords, maxFields })` reads CSV/TSV (delimiter auto-detect) and JSON into `{ fields, records, warnings }` with header normalisation, padding and caps. `matchFields(variables, fields)` maps variables to fields case-/space-insensitively and through aliases (`FirstName`/`First`/`GivenName`, …); `recordToValues` builds prompt values.
- **Merging**: `mergeRecords(template, source, { mapping, skipIf, separator, maxOutputs, maxLength, from, to })` resolves one output per record with source maps, skips records with a condition or function, and reports diagnostics. `serializeMergeOutputs` writes text or JSON.
- **React / Svelte**: `<MergePreview />` (paste or pick CSV/JSON, editable field mapping, Prev/Next record preview, Merge all with copy/download) plus `useMergePreview` / `createMergePreview`. `TemplateRenderer` shows comparison tags.
