---
"@pixerate/editor": minor
---

Add `@pixerate/editor/effects`, a dependency-free contract for optional effects providers. `EffectProvider` lists, searches and describes effects (strict JSON Schema controls, defaults, presets and named inputs) and creates frame-exact renderers at 8, 16 or 32 bits with masks, plus `applyVectorEffect` for vector motion. Typed errors (`UnknownEffectError`, `EffectControlError`, `EffectUnsupportedError`, `EffectDisposedError`, `NoEffectsProviderError`), capability flags, `resolveEffectValues`, `searchEffectSummaries`, `applyEffectMask`, `EffectsSlot`, a `checkEffectProvider` conformance check for provider test suites, and `createFakeEffectProvider`, a deterministic CPU provider for tests and demos.

`FlairSvgAnimation` gains Flair's `tag`, `format`, `decimals` and `caret` fields. `checkEffectProvider` accepts `unsupported` from a vector effect's renderer and from the vector probe.
