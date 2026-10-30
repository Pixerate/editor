---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

The Select and Mask workspace. React and Svelte add `<SelectAndMaskWorkspace>`, a full-window workspace that opens from a "Select and Mask…" button in the selection options bar.

- **Tools:** Quick Selection, Refine Edge Brush, Brush, Object Selection, Lasso, Hand and Zoom.
- **Views:** Onion Skin, Marching Ants, Overlay, On Black, On White, Black & White and On Layers, with Photoshop's keys (O, M, V, A, T, K, Y and F to cycle), opacity, Show Edge (J) and Show Original (P/X).
- **Settings:** Real-Time Refinement, High Quality Preview, edge detection and refinement, Output To, Decontaminate Colors and Remember Settings.
- **Preview:** a live preview on a copy reduced to 1024 px.

OK runs the same `refineSelectionTo` call an agent makes, as one undo step. Cancel and Escape change nothing, and Ctrl/⌘+Z undoes a stroke inside the workspace. The core holds the logic in a framework-free `SelectAndMaskSession`, which manages settings, strokes, the preview, view rendering, keys and commit. `RefineEdit` gains `lasso` and `object` kinds, so every workspace tool has an agent equivalent in `refine_selection` `edits`. New exports: `SelectAndMaskSession`, `SELECT_AND_MASK_VIEWS`, `SELECT_AND_MASK_TOOLS`, `DEFAULT_SELECT_AND_MASK_SETTINGS`, `forgetSelectAndMaskSettings` and the `SelectAndMaskSettings`, `SelectAndMaskView` and `SelectAndMaskTool` types.
