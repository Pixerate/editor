---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor selections: one agent tool per operation, Color Range presets and tool, and a selection-masking workflow skill.

- New agent tools: `select_all`, `deselect`, `invert_selection`, `select_rect`, `select_ellipse`, `select_polygon`, `magic_wand` (with `distance`), `select_color_range` (samples or a preset, `fuzziness`, `localized`, `invert`), `load_selection_from_image`, `load_selection_from_mask` and `set_selection_display`. `select_region` and `select_by_color` still work but are deprecated and will be removed in the next minor release.
- Core: `colorRangePreset` / `skinToneRange` and `COLOR_RANGE_PRESETS`, `controller.selectColorRangePreset`, `invert` on selection commands, `controller.setSelectionDisplay` / `getSelectionDisplay` (`'ants' | 'quickMask' | 'none'`), `invert` on `selectionFromLayerMask`, and `maskThumbnailClick`.
- `SelectionGesture` and `SelectionToolOptions`: a `range` (Color Range) tool, where a click samples a colour, Shift-click adds one and Alt-click removes one; `feather`, `fuzziness`, `localized` and `rangeInvert` options.
- React and Svelte: `SelectionOptionsBar` gains the wand's colour distance, a Feather field, Color Range options and presets, and an Ants / Quick Mask / Hidden display switch (new `selectionDisplay` prop). In `LayersPanel`, Ctrl/⌘-click on a mask thumbnail loads the mask as the selection (with Shift to add, Alt to subtract).
- Skills: new workflow skill `pixerate-image-selection-masking`; `pixerate-image-editor` documents the new tools.
