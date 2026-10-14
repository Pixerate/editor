---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor selections and masks. Core (`@pixerate/editor/image-editor`): 8-bit `SelectionMask` selections with magic wand (scanline fill, RGB or perceptual tolerance, contiguous / global, sample merged), colour / tone / hue range, rectangle / ellipse / lasso, replace / add / subtract / intersect, grow / shrink (exact distance transform), feather, border, smooth, invert, and guided-filter Refine Edge (radius, smart radius, smooth, feather, contrast, shift edge) for snapping coarse AI masks to image edges. Selections are undoable, saved run-length encoded as an optional `selection` key, shown as marching ants or a Quick Mask tint, and included in `toMaskDataURL()`. Adjustment layers get an optional `mask` with non-destructive density and feather (`applySelectionAsLayerMask`, `selectionFromLayerMask`), resampled through crop / rotation / flips. Selection- and mask-free documents serialize exactly as before. New agent tools: `get_selection`, `select_region`, `select_by_color`, `modify_selection`, `refine_selection`, `apply_selection_as_mask`. React and Svelte: `SelectionOptionsBar`, `RefineEdgePanel` and a Select & Mask tab in `ImageEditor`.
