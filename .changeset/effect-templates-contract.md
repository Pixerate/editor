---
"@pixerate/editor": minor
---

Effects contract: sequence templates. A provider with `capabilities.supportsTemplates` implements `listTemplates`, `describeTemplate` (slots shaped for a form) and `instantiateTemplate`, which fills slots to an `EffectSequence` of shots with effect layers, catalog transitions and camera moves, or returns every bad value as a sentence. Adds `UnknownTemplateError`, the template and sequence helpers (`templateValuesSchema`, `checkTemplateValues`, `checkEffectSequence`, `effectLayerInput`, …), template checks in `checkEffectProvider`, and two templates on `createFakeEffectProvider({ templates: true })`.
