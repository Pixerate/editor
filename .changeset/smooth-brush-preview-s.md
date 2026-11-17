---
'@pixerate/editor': patch
---

Brush previews draw their sample S as a smooth curve. `renderVectorBrushPreview` and the canvas swatch (`renderCanvasBrushSwatch`, `renderCanvasBrushPreview`) sampled it as a few straight segments (nine for dry brushes), so a thin hard tip such as the fineliner showed visible corners; both now share `brushPreviewPoints`, which samples the S at least every 2 px.
