---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add non-destructive path effects and live booleans to the vector editor.

- Paths and groups carry an editable effect stack (`effects`: Trim Paths simultaneous / individual, Round Corners, Pucker & Bloat, Twist, Zig Zag, seeded Wiggle Paths, Offset Paths with copies, Merge Paths, Repeater with an opacity ramp and fractional copies), stacked as in After Effects: effects act on every path above them and effects after a repeater act on its copies. `expandVectorAppearance` evaluates them in one cached place that rendering, hit-testing, bounds, snapping, booleans, the Pathfinder, Outline Stroke and SVG export read; anchors stay editable.
- Controller: `addEffect`, `updateEffect` (slider drags merge into one undo step with `{ merge }` / `endMergedEdit`), `moveEffect`, `removeEffect`, `expandAppearance`, and `booleanOp(op, { live })` for live boolean groups whose operands stay editable, each with its own operation, folded with a prefix cache. The destructive `booleanOp` stays the default.
- Agent commands `vector.addEffect`, `vector.updateEffect`, `vector.removeEffect`, `vector.expandAppearance` and a `live` option on `vector.boolean`; SVG export keeps effects and live booleans for round-tripping.
- React and Svelte: an Effects section in `VectorStylePanel` (also `VectorEffectsPanel`) and a Live toggle for the toolbar's boolean buttons.
