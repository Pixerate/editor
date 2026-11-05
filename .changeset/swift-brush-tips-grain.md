---
"@pixerate/swift": minor
---

Swift paint editor: stamp tips (editor stamps and image sources) in the dab, pick-up, spray and particle paths, image brush sources (`BrushLibrary.addSource` / `listSources` / `getSource`, `sources` in library files, the `add_brush_source` and `list_brush_sources` tools, unknown `source:` refs refused), tip grain (`tip.grain`: texturised and moving, scale, depth, contrast, invert), `dynamics.count` and `dynamics.flip`, the `tipGrain` / `dabCount` profile capabilities, and `brushSources` in saved paintings. Stamp tips are now in `PaintEditorView`'s brush picker. The `brush-tips-and-grain` and new `stamp-tips` paint scenarios pass (#646).
