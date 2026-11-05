---
"@pixerate/swift": minor
---

**Swift vector editor: the controller and its commands (#622).**

- `VectorEditorController` in `PixerateVector`: the document, selection, tool, editing options and defaults, with one undo step per change on its `HistoryManager`. Transforms (move, scale, rotate, set rotation), skew, Free Distort, align, distribute, arrange, group, ungroup, layer moves, booleans and live booleans, Pathfinder, the Shape Builder, the paint bucket, anchor edits (move, bend, delete keeping the shape), Join, Average, Smooth, Remove Redundant Points, Scissors, Knife, Eraser, the distortion brushes (smudge, twirl, attract, repel, roughen), drawing by dimensions, and SVG export of plain paths and groups.
- `createVectorCommands`: all 150 vector commands, with their label, group, keywords, description, params schema and shortcut read from the contract (`commands.json`) and their TS enablement. The commands the controller does not have yet fail with "not ported to Swift yet (#624)".
- `VectorConformanceHost` and `VectorConformanceTests`: the `shapes-and-paths`, `arrange-and-transform`, `booleans-and-pathfinder` and `path-editing` scenarios pass; the other ten are skipped (#624).
- Live boolean groups now draw and are bounded as their folded operands (`expandVectorAppearance`, `vectorAppearanceShapes`).
