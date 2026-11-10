---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
"@pixerate/swift": patch
---

Paint editor fixes:

- Replayed strokes keep their own brush id: `list_strokes` reported a replayed antimatter stroke (or any replay while another brush was active) with the active brush's id (`pencil-6b`) next to the stroke brush's name. Fixed in TS and Swift.
- Swift brush normalization drops `iridescence` from `marks.kind: "antimatter"` brushes as TS does, with the same messages.
- Biopaint catches up on growth while closed whenever the document is replaced, not only when the canvas mounts: new `controller.onDocumentReplaced(listener)` (fired by `loadJSON`, `loadJSONAsync` and `newCanvas`) and `startCultureCatchUp(controller)`, used by the React and Svelte `PaintCanvas`; Swift adds `onDocumentReplaced` and `PaintEditorModel` catches up on it.
- The `time-machine` conformance scenario paints with real presets, so ageing, X-ray and the scraper now run over real paint. That exposed a Swift scraper rounding difference (half-to-even instead of `Math.round`'s half-up on alpha and impasto height), now fixed.
