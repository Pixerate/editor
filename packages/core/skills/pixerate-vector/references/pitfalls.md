# Vector editor pitfalls by area

Detail moved out of SKILL.md (progressive disclosure). Each pitfall says what goes wrong and what to do instead.

- Mesh and freeform fills draw as fine tiles, not SVG gradients: they cannot be edited with
  `vector.setGradient` or as stops, and other tools see them as SVG patterns. Point indices
  shift after `vector.removeFreeformPoint`; read them again with `vector.getShading`.

- A connector's geometry is regenerated after every edit while an end is glued: editing its
  anchors directly does not stick. Unglue the end (`vector.setConnector` with `null`) or change
  `route` instead. Connectors cannot be glued to connectors.

- Scaling a frame (`vector.scale`, the selection handles) lays its children out by their
  constraints, so it is a resize, not a zoom; group the frame (or scale its children) to scale the
  art itself. A frame clips by default: objects moved outside it disappear (`clip: false` shows
  them). Moving an object over a frame does not put it inside; use `vector.frameSelection` or
  `adopt`.

- The `d` in `vector.list` draws live corners cut, which adds anchors. On a path with corner
  radii, anchor indices counted from `d` do not match the stored anchors; count anchors on a path
  without corners, or clear corners first.
- `vector.boolean` without `live` fails when the result is empty (shapes that do not overlap)
  and consumes its inputs. Subtract removes upper shapes from the lowest: restack with
  `vector.arrange` first.
- `vector.blend`, `vector.group` and live booleans need nodes that share a parent.
- Blend in-betweens are locked and regenerate; edit the keys, not the steps.
- `strokeAlign` inside and outside only apply when every subpath is closed.
- Layer indexes shift after a remove or a move: use the stack each write returns.
- Path effects apply to the whole node, every layer alike. Blend in-betweens mix the top fill and
  stroke only.
- In a mask group the order matters: the bottom child is always the mask. `vector.arrange` inside
  the group can change which object masks; deleting the mask releases the group instead.
- A mask group's path effects act on its contents, not on the mask. Hit-testing, bounds,
  snapping and booleans use the masked result; an opacity mask counts wherever it paints, even
  where it is dark.
- Filters and blend modes are drawn, not geometry: bounds, snapping, booleans and Outline Stroke
  ignore them. A node's blend mode and filter isolate its layers, so layer blend modes inside a
  node with a filter mix only with the node's own layers. Background blur is not available.
- Text positions are code units: an emoji or other character outside the Basic Multilingual
  Plane counts 2. Take ranges from `vector.getText` rather than counting characters yourself.
- Scaling text scales its font size (by the square root of the area change) and an area box per
  axis; it is never stretched. Skew is not kept on text.
- Without an outline shaper (`vector.listFonts` `outlines: false`), text exports as SVG `<text>`
  positioned character by character; other viewers need the same fonts installed. Create Outlines
  (with an outline shaper) when the SVG must look the same everywhere.
- An instance's `transform` may scale; its art's strokes scale with it unless `scaleStrokes: false`.
  Transform commands act on the instance, not the art: edit the art with `vector.editSymbol`.
- While a symbol is being edited (`vector.listSymbols` `editing`), `vector.list` lists its art, not
  the document. Always finish with `vector.exitSymbolEdit`. A symbol cannot contain an instance
  of itself (directly or through another symbol).
- Constraint refs to anchors give them stable ids; later anchor edits keep them, but rebuilding a
  path (booleans, Outline Stroke, Expand) drops them, and constraints on missing anchors are
  removed. `segment` means the straight line between two anchors, even when the segment is curved;
  `tangent` / `smooth` on one anchor act on its handles.
- After any edit the solver moves the rest of the geometry to keep the constraints; the anchors
  you just moved move least. A fixed or fully constrained part will not move: remove or change a
  constraint first.
- `vector.typeOnPath` consumes the path. Duplicate it first if the path should stay visible.
- Master art on a page is drawn from its master page and is locked there: edit the master page
  (its id from `vector.listPages`, `parentId` to add to it), not the page. Give master objects
  `resizing` (for example `vertical: "bottom"` for a footer) so they sit right on pages of other
  sizes. Master pages are not pages: they are not numbered and PDF export by artboards skips them.
