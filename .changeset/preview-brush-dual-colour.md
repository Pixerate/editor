---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

`preview_brush` without `color` now draws in the colour the brush panel previews with (`brushPreviewColours`): a light / dark `colour.default` takes the side for the renderer's paper (dark paper for brushes that give off light) instead of falling back to slate, and a colour that would not read is made darker or lighter. The result's `structuredContent` adds `color`, the #rrggbb it drew in. The Swift paint editor's `preview_brush` does the same (`brushPreviewColours` in `PixeratePaint`).
