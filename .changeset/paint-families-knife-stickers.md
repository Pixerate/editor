---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Paint families, a palette knife tool, and sticker brushes that trace the path at large sizes.

- **Paint families.** Brushes gain a second facet beside their medium `category`: `family`, what the paint does (`dry`, `ink`, `wet`, `thick`, `metallic`, `spray`, `glow`, `iridescent`, `strands`, `stickers`, `living`, `ethereal`, `volatile`, `reactive`). Every preset declares one, and `resolveFamily` derives it for brushes that don't; tools have none. `PaintBrush.family`, `PAINT_FAMILIES`, `PAINT_GROUPINGS.byMedium` / `byFamily` (ordered groups with an id, label and member rule; also in the paint UI contract as `paintGroupings`) and `paintBrushGroup` let a host group its library either way. `list_brush_presets` filters by `family` and reports it, as does `describe_brush`, and the brush editor has a Family choice.
- **Palette knife tool.** `palette-knife` is now a tool (`kind: 'tool'`, `tool: 'knife'`) that carries no paint: it scrapes and spreads the thick paint already on the layer (`brushTakesPaint` is false). Its category is `smudge`. The paint-loaded knife mark is retired; a saved brush based on it keeps working as a thick mark brush.
- **Stickers at large sizes.** Sticker spacing and scatter scale with the sticker only up to `STICKER_REACH` (64 px), so big stickers stay on the stroke instead of landing far apart and off the path, and a stroke always ends with a sticker at its end.
