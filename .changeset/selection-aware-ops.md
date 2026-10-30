---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor: operations that respect the selection.

- **Adjustment layers and filters follow the selection:**
  - `AdjustmentLayerInit.useSelection` masks a new adjustment layer by an active selection. It defaults to false in the API for compatibility. The `add_adjustment_layer` tool and the panels pass true, and the result says `masked`.
  - `applyEffectFilter` and `addSmartFilter` take `useSelection`, which sets the smart filter mask from the selection in the same undo step. `apply_effect` always does this; `add_smart_filter` does unless `useSelection: false`.
- **Edit › Stroke:** `strokeSelection({ width, location })` and `selectionRing`, built from the exact distance transform. Tool `stroke_selection`.
- **Crop to the selection:** `cropToSelection()` and the tool `crop_to_selection`.
- **Content-Aware Fill of the selection:** `contentAwareFill({ output, sampleRadius, seed })`, which reuses the PatchMatch fill from Spot Healing. It is deterministic for a seed and works on 8-bit documents only. Tool `content_aware_fill`.
- **Pixel clipboard:**
  - `copyPixels({ merged })`, `cutPixels`, and `pastePixels(mode)` with modes `new-layer`, `in-place`, `into` and `outside`.
  - `getClipboard` / `setClipboard`.
  - Tools `copy_pixels`, `cut_pixels` and `paste_pixels`. Paste Into and Cut are each one undo step.
- **Select-mode shortcuts:** `handleSelectionShortcut` handles Ctrl/⌘ C (with Shift, Copy Merged), X, V (with Shift, in place; with Alt+Shift, into), D, Shift+D and Shift+I. The React and Svelte canvases route these keys.
- **`SelectionOptionsBar`:** Stroke with a width and location, Crop to Selection, Content-Aware Fill, Copy, Copy Merged, Cut, Paste, Paste in Place, Paste Into and Paste Outside.
- **Skills:** `pixerate-image-editor` documents the tools, and its Free Transform guidance moves to `references/free-transform.md`. `pixerate-image-selection-masking` gains recipes for removing an object, outlining a cutout, cropping to a subject and pasting into a shape.
