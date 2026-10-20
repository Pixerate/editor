---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

CAD-style drawing aids in the vector editor: object snap tracking, polar increments and typed dimensions.

- **Object snap tracking:** rest on an anchor to acquire it. It then sends alignment paths, plus an open path's extension, and points snap where those paths cross.
- **Polar tracking:** pick an increment (`vectorPolarAngles`), optionally measured from the last segment.
- **Typed entry while the pen draws:** a distance, `length<angle`, an `@offset` or a position. `placePenPoint` does the same from code, and `addPathByDimensions` draws a whole path from dimensions.
- **New agent commands:** `vector.getSnapOptions`, `vector.setSnapOptions` and `vector.addPathByDimensions`.
- **Bindings:** the canvases draw tracking markers and the typed entry, and the toolbars gain a polar increment picker.
