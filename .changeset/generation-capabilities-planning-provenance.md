---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add `@pixerate/editor/generation`: declarative model capability descriptors (media kind, prompt limits counted on resolved text, negative/system prompts, aspect ratios, resolutions, quality, output count, durations, seeds, reference inputs by role with per-role and total limits, edit/inpaint modes, extra numeric/enum/boolean params, timing). `planGenerationRequest(request, caps, { strategy })` snaps, clamps, truncates and drops unsupported values with a report of every adjustment and error (`error`, `nearest`, `downgrade`, `upgrade` strategies). `capabilitiesToJsonSchema`, `mergeCapabilities`, and `createGenerationToolProvider` add `list_models`, `plan_generation`, `estimate_generation` and an idempotent `generate` (deduplicated by `idempotencyKey`) to a `ToolRegistry`. `createProvenance` / `serializeProvenance` / `parseProvenance` / `recreateRequest` record pinned template versions, values, the resolved prompt and source map, and the planned settings. Also adds `createBatchResolver`, `estimateJobProgress`, `expectedDurationFor`, and headless form helpers (`getGenerationControls`, `getReferenceSlots`).

React (`@pixerate/editor-react/generation`): `useGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `useJobProgress`. Svelte (`@pixerate/editor-svelte/generation`): `createGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `createJobProgress`.
