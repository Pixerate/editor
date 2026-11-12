---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Write and save authored effects in the Swift paint editor, and let agents look at them (#752).

- Swift: `EffectAuthoringEditor`, a SwiftUI effect authoring editor matching React's and Svelte's `<EffectAuthoringEditor>` (toolbar with play, undo, redo and save preset; a preview drawn by `PixelMetalRenderer` for `pixel` sources when Metal is available, else on the CPU; the source with line numbers and issue markers; parameters with a keyframe toggle per control; a timeline), on `EffectAuthoringModel`, which follows the session an agent may also be changing. macOS 14 and iOS 17.
- Swift: with the `author` policy, the paint editor's Effects tab offers New effect (from the `pixel.*` templates) and Edit on each authored effect, opening the editor in a sheet with Save to painting (`saveAuthoredEffect`). Hidden for `replay` and `off`.
- Core and Swift: the paint editor's authoring tools now include `effect_authoring_view`, a PNG of the open effect at the playhead (or at `time`), in the painting's aspect with its longest side at most 256 px (`paintAuthoringViewSize`, `captureAuthoringPreview` in Swift). The `effect-authoring` conformance scenario covers it.
- Swift: `effectAuthoringViewHandler`, `EffectAuthoringToolHost.capture`, and `effectSamplePicture` / `effectSampleInputs` (sample pictures for filter and transition previews), as in the TS core.
