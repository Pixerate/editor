---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor: the simple selection tools Photoshop has and we lacked.

- **Polygonal lasso** (`polygon` tool in `SelectionGesture`):
  - Click to add corners. Shift snaps to 45°. Drag for a free-hand stretch.
  - Double-click, Enter or a click on the first corner closes it. Backspace removes a corner and Escape cancels (`gesture.key`).
  - The React and Svelte canvases route the keys and keep the outline showing between clicks.
- **Single row and column marquees** (`row` / `column` tools), `controller.selectLine` and the agent tool `select_line`.
- **Reselect:** `controller.reselect` / `canReselect` and the tool `reselect`.
- **Grow and Similar, by colour:**
  - `growSelection` / `selectSimilar` in core, the same on the controller, and the tools `grow_selection` / `select_similar`.
  - The distance-based operation is now called Expand / Contract: `modify_selection` `op` takes `expand` / `contract`, and `grow` / `shrink` still work as aliases.
- **Select a layer's pixels:**
  - `controller.selectLayerTransparency`, the tool `select_layer_transparency` and `layerThumbnailClick`.
  - Ctrl/⌘-click a layer thumbnail in `LayersPanel`, with Shift to add and Alt to subtract.
  - A "Select Layer Pixels" item in the layer menu.
- **New mask sources:** `addLayerMask` and `add_layer_mask` take `from: 'hide-selection'` and `'transparency'`. The layer menu gets "Add Mask Hiding Selection" and "Add Mask from Transparency".
- **Options bar:** Reselect, Grow and Similar buttons, Expand and Contract labels, and a hint for the polygonal lasso.
- **Skills:** `pixerate-image-editor` and `pixerate-image-selection-masking` cover the new tools.
