---
'@pixerate/editor': minor
---

Paint editor: theme-reactive dual colours, and extension PNGs in external saves.

- A stroke can be painted in a light / dark pair (`DualColor` from `@pixerate/editor/color`): `PaintStrokeInit.color`, `setColor({ light, dark })`, `updateStroke` `color`, a brush's light / dark default, or the `set_color` tool's new `dualColor` argument. It paints the side of the colour scheme and records the pair (`RecordedStroke.dualColor`), which saved documents round-trip.
- `setColorScheme(scheme)` redraws dual-colour strokes on stroke layers in the new side. It is not an undo step: undo, redo and loading a document keep the strokes drawn for the current scheme. Plain `#rrggbb` strokes, and the pixels of pixel layers, stay as painted.
- `toJSONExternal(store)` now also stores the PNGs inside extension fields (light, thick-paint channels, fluorescence, thermochromic, ferrofluid, heat, the mixing pad, brush sources, guides and later fields) in the asset store, referring to them as `asset:<id>`, so saved documents hold no inline data URLs; `loadJSONAsync` puts them back and reports any it can't fetch.
