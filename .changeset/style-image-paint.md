---
"@pixerate/editor": minor
---

House style for images and paintings (#779).

- `imageStyleDomain` (`image-editor.json`): output aspect ratios (findings carry the centred crop to the nearest house ratio for `set_crop`), a minimum size, ranges for the base adjustments, and the brand's palette-only / fonts-allowed on annotations. Agent tools `check_image_style` and `fix_image_style` (clamps the adjustments as one undo step; hidden when read-only), `createImageStyleToolProvider`.
- `paintStyleDomain` (`paint-editor.json`): papers (from the paper library) and brushes allowed, a layer limit, and the brand's palette-only on stroke colours, the current colour and swatches. Agent tools `check_paint_style` and `fix_paint_style` (switches to the house paper and brush), `createPaintStyleToolProvider`. Not in the Swift paint editor yet.
