---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

The Content-Aware Fill workspace. React and Svelte add `<ContentAwareFillWorkspace>`, which opens from "Content-Aware Fill…" in the selection options bar when something is selected.

- **Source view:** the selection's surroundings, with the sampling area (where the fill may copy from) in green.
- **Sampling area:** painted with the Sampling Brush (Alt subtracts), or set with the Auto and Rectangular presets.
- **Preview:** a live preview next to the source view.
- **Fill settings:** Seed with Try Another, Output To (new or current layer), Live Preview, and Hand and Zoom.
- **OK and Cancel:** OK fills as one undo step; Cancel and Escape change nothing.

The core holds the logic in `ContentAwareFillSession`. The engine's `contentAwareFill` gains `exclude`, pixels no source patch may cover. Agents get the same choice through `content_aware_fill` with `sampleRects`, `excludeRects` and `samplingChannelId`, and the tool now runs in the selection worker when there is one. Also new on the controller: the `samplingArea` option, `prepareContentAwareFill`, `previewContentAwareFill` (no changes made) and `contentAwareFillAsync`, plus the `ContentAwareFillPlan` type.
