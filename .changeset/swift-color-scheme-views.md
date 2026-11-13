---
'@pixerate/swift': minor
'@pixerate/conformance': patch
---

Swift paint editor: light / dark (dual-colour) paint follows the viewer's colour scheme, as in the TS core (#718, #720).

- Strokes record a light / dark pair: `PaintStrokeInit.dualColor`, `setColor(dual:)`, the `set_color` tool's `dualColor`, a brush's light / dark default, and `updateStroke(dualColor:)`. A plain colour drops the pair.
- Stroke layers keep each pair's light side in the document and show the `setColorScheme` side in the view (display, image and PSD exports, the stroke being drawn); the document, history and saved file don't change with the scheme.
- Pixel layers, wet paint included, show the scheme's side through a replay of the stroke log into a view-only editor (`SchemeReplay`): built in the background by the host's clock (`runSchemeReplay`; `PaintEditorModel.runSchemeReplayClock` in the editor view), kept current from new strokes and events, a live stroke followed point by point, undo and redo rolled back to checkpoints. Layers holding pixels the log doesn't have are marked (`PaintDocumentState.unlogged`, saved as the `unlogged` extension with documents that hold dual-colour strokes) and keep their colours.
- `colorSchemeView()`, `colorSchemeViewReady()` and the `get_color_scheme_view` agent tool (with `wait`); the layers panel marks kept (◐) and updating (⟳) layers; `PaintEditorView` follows the system appearance (`followsColorScheme`), and the Swift demo has a scheme switch.
- A paint colour that came from a light / dark brush default now follows `setColorScheme` even when the colour is locked, as in the TS core.
- `replayItem`, `advanceReplayClock` and `replayStrokeInit` are split out of `replayPainting`; a wet stroke's points applied at one clock are pushed together, as in TS.
- Conformance: the `color-scheme-replay` scenario's Swift skip is removed; all 69 paint scenarios pass in Swift.
