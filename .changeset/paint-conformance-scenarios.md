---
"@pixerate/editor": minor
---

Paint conformance scenarios for the Swift port (#535). `@pixerate/conformance` gets `domains/paint/fixtures`: 21 recorded scenarios that call all 130 paint tools (layers, brushes, live strokes, guides, wet and thick paint, stickers, layer styles, effects, the brush library, proposals, exports) with each call's result, saved documents and pixel snapshots, plus `schema/fixture.schema.json`. `@pixerate/editor/tools` exports the runner (`runConformanceScenario`, `normalizeConformanceValue`, `ConformanceIds`, `omitConformancePaths`) and `@pixerate/editor/paint-editor` exports `createPaintConformanceHost`. `pnpm conformance:record` records them from the built core; a core test replays them and fails when a paint tool has no scenario.
