---
'@pixerate/editor': minor
---

Paint editor: theme-reactive dual colours, and extension PNGs in external saves.

- A stroke can be painted in a light / dark pair (`DualColor` from `@pixerate/editor/color`): `PaintStrokeInit.color`, `setColor({ light, dark })`, `updateStroke` `color`, a brush's light / dark default, or the `set_color` tool's new `dualColor` argument. The stroke records the pair (`RecordedStroke.dualColor`), which saved documents round-trip.
- On a stroke layer the document draws dual-colour strokes in their light side, whoever painted them, and each editor shows them in its own `setColorScheme` side: display, image and PSD exports and the stroke being drawn follow the scheme, while the document, history and change listeners don't hear of a scheme change. Strokes loaded from saved or shared documents follow it too. Plain `#rrggbb`, gradient and effect paint are never recoloured, and pixel layers keep the side painted.
- `toJSONExternal(store)` now also stores the PNGs inside extension fields (light, thick-paint channels, fluorescence, thermochromic, ferrofluid, heat, the mixing pad, brush sources, guides and later fields) in the asset store, referring to them as `asset:<id>`, so saved documents hold no inline data URLs; `loadJSONAsync` puts them back and reports any it can't fetch.
