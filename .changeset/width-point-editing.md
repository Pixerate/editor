---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector editor: more of the Width tool and profile-aware arrowheads.

- Width tool: Alt-drag a width point's centre to slide a copy; dropping a slid point onto another makes a discontinuous point (the width steps there); Shift-click adds or removes width points from a multi-selection, dragging one of several selected points moves or widens them together, and Delete removes them all.
- **Breaking:** `VectorEditorState.selectedWidthPoint` (one ref or null) is now `selectedWidthPoints` (a list, all on one path). New `selectWidthPoints(refs)` and `removeWidthPoints(refs?)`.
- Width Point Edit: double-click a width point or a stroke with the width tool to edit its position and left / right side widths numerically. Headless as `state.widthPointEdit` with `openWidthPointEdit`, `commitWidthPointEdit`, `closeWidthPointEdit` and `setWidthPoint({ nodeId, index? }, { t, left, right })`, plus a `vector.setWidthPoint` agent command; React and Svelte `<VectorCanvas>` show the new `<VectorWidthPointEditor>` beside the point.
- Arrowheads on variable-width strokes are sized from the profile's width at their end, with the stroke width as a floor (a taper to nothing still gets a full-size head).
