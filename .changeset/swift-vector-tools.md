---
"@pixerate/swift": minor
---

**Swift vector editor: effect and generation agent tools; the vector domain is fully ported (#624).**

- Provider vector effects (`ControllerEffects.swift`, from `vector/controller.ts`): `addVectorEffect`, `updateVectorEffect`, `detachVectorEffect`, `vectorEffectGroups` and the effects slot (`effectsProvider`, `setEffectsProvider`, `useEffects`). A vector effect's SVG is read with the SVG importer into a group that keeps its `providerEffect` and draws as a plain group in render data and SVG export.
- `createVectorEffectsToolProvider` (`search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`, `remove_effect`) on the shared effect tools, now `effectToolHandlers` with an `EffectToolHost` in `PixeratePaint`, which `createPaintEffectsToolProvider` uses too. `VectorEffectProvider` adds `applyVectorEffect`; `FakeEffectProvider` implements it (`badge`, `route`, `fade-in`) as the TS fake does.
- Generation (`Generate.swift`, from `vector/generate.ts`): `generateVectorArt`, `regenerateVectorArt` (keeps the group's id, place and transform), `replaceGeneratedArt`, `vectorArtModels`, idempotency keys, `createVectorGenerationToolProvider` (`list_vector_art_models`, `generate_vector_art`, `regenerate_vector_art`) and `FAKE_VECTOR_ART_MODELS` / `fakeVectorArtGenerator`. SVG export writes `data-vector-generation` and SVG import reads it back.
- Generation planning in `PixerateCore` for any domain (`generation/capabilities.ts`, `plan.ts`, `provenance.ts`, `hash.ts`): `ModelCapabilities`, `planGenerationRequest` with every strategy, `createProvenance` (prompts as written; templates and values are not ported), `parseProvenance`, `stableStringify`. `jsToFixed` moved to `PixerateCore`.
- `VectorConformanceHost` registers both providers; all 15 vector scenarios pass, and `VectorConformanceTests` fails if a vector scenario is skipped.
