# Vector editor

`@pixerate/editor/vector` is a headless vector drawing editor: a document of Bézier paths and groups, the select / direct-select / pen / pencil / shape tools, transforms, boolean operations, alignment, grouping, undo, SVG import and export, and agent commands. It has no DOM or third-party imports, so it runs in the browser, Node.js and workers. React (`@pixerate/editor-react/vector`) and Svelte (`@pixerate/editor-svelte/vector`) add the same hooks / runes and an SVG canvas, toolbar and style panel.

## Document model

```ts
import { rectSubpath, type VectorDocument } from "@pixerate/editor/vector";

const doc: VectorDocument = {
  width: 800,
  height: 600,
  background: "#fff",
  nodes: [
    {
      id: "wave",
      type: "path",
      fill: null,
      stroke: "#0ea5e9",
      strokeWidth: 3,
      subpaths: [
        {
          closed: false,
          anchors: [
            { x: 0, y: 100, out: { x: 50, y: 0 } },              // handles are absolute positions
            { x: 100, y: 100, in: { x: 50, y: 200 }, type: "smooth" },
          ],
        },
      ],
    },
    { id: "box", type: "path", fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#f43f5e" }, { offset: 1, color: "#7c3aed" }] }, subpaths: [rectSubpath({ x: 200, y: 50, width: 120, height: 80 }, 12)] },
    { id: "g1", type: "group", children: [/* … */] },
  ],
};
```

- A **path** has one or more subpaths (holes and compound shapes), a fill and stroke (any CSS colour, a gradient, or `null`), stroke width / caps / joins / dashes / alignment, an optional width profile (`strokeWidthProfile`), arrowheads, a fill rule and opacity.
- An **anchor** has optional `in` / `out` handles (absolute document positions). A segment with no handles at either end is a straight line; otherwise it is a cubic Bézier. `type` is `corner`, `smooth` (handles in line) or `symmetric` (in line, equal length) and decides how the opposite handle follows when one is dragged. An optional `corner: { radius, kind }` is a live corner (see below).
- A **group** selects and transforms its children together. Nodes can be hidden (`visible: false`) or locked (drawn, not pickable).
- A node's optional **`transform`** places it in its parent's space. It is always *rigid* (rotation + translation): anchors and children live in the node's own space. `transformVectorNode(node, m)` composes `m`, keeps the rotation in `transform` and bakes any scale, skew or mirroring into the anchors (or children), so stroke widths, hit-testing tolerances and the rotated selection box stay exact. Unrotated nodes have no `transform` and store document positions directly.

Matrix helpers: `decomposeRigid` (any matrix → residual × rigid), `matrixRotation`, `vectorNodeRotation`, `vectorWorldMatrix` / `vectorParentMatrix` (a node's local / parent space → document), `vectorPathWorldBezier`, `invertMatrix`, `getAnchorWorld` and `getVectorSelectionFrame`. Bounds and hit-tests take an optional parent matrix and default to the node's parent space.

Geometry helpers work on this model directly: `vectorPathData`, `bezierToSubpaths` (SVG path data → anchors, quadratics and arcs become cubics), `vectorNodeBounds` (exact curve bounds), `hitTestVectorNode`, `nearestSegment`, `insertAnchor` (de Casteljau split, shape unchanged), `convertAnchor`, `moveAnchorHandle`, `transformVectorNode` with `translateMatrix` / `scaleMatrix` / `rotateMatrix`, and shape factories (`rectSubpath`, `ellipseSubpath`, `polygonSubpath`, `starSubpath`, `lineSubpath`).

## Controller

```ts
import { VectorEditorController } from "@pixerate/editor/vector";

const editor = new VectorEditorController({
  document: doc,
  defaults: { fill: "#e4e4e7", stroke: "#18181b", strokeWidth: 2 },
  snap: { grid: 8 },
  onChange: (doc) => save(doc),
});

editor.subscribe((state) => render(state)); // state is stable until something changes
```

The UI forwards events in canvas pixels; the controller converts them with its viewport (`screen = document × zoom + (x, y)`):

```ts
canvas.onpointerdown = (e) => editor.pointerDown(local(e), toVectorPointerInput(e));
canvas.onpointermove = (e) => editor.pointerMove(local(e), toVectorPointerInput(e));
canvas.onpointerup = (e) => editor.pointerUp(local(e), toVectorPointerInput(e));
canvas.ondblclick = (e) => editor.doubleClick(local(e));
canvas.onwheel = (e) => editor.wheel(local(e), { x: e.deltaX, y: e.deltaY }, toVectorPointerInput(e));
canvas.onkeydown = (e) => { if (!isVectorTextTarget(e.target) && editor.keyDown(toVectorKeyInput(e))) e.preventDefault(); };
canvas.onkeyup = (e) => editor.keyUp(toVectorKeyInput(e));
```

| Tool (key) | Pointer |
| :--- | :--- |
| Select (V) | Click / Shift-click / marquee to select; drag to move (Shift locks an axis, Alt duplicates); box handles resize (Shift keeps proportions, Alt from the centre); the round handle rotates (Shift snaps to 15°); double-click a path to edit its points |
| Direct select (A) | Click or marquee points; drag points (a lone point bends its segments when Curvature moves are on; Alt during the drag flips that) or handles (Alt breaks a smooth pair); click a segment to select its points, drag it to bend it through the pointer; Alt-drag a point to pull out smooth handles; Alt-click a segment to add a point; double-click a point to toggle corner / smooth |
| Pen (P) | Click for corners, drag for curves (Alt moves only the outgoing handle, Shift snaps to 45°); click the first point to close; Enter / Escape / double-click to finish; click an open path's end to continue it; Backspace removes the last point |
| Pencil (N) | Freehand; the stroke is fitted to cubic Béziers. Lazy-mouse smoothing (`pencilSmoothing`) and shape recognition (`recognizeShapes`) are optional. Pen pressure is recorded as a width profile (`pencilPressure`: `pen` by default, `all`, `off`) |
| Scissors (C) | Click a path: cuts it there (at an anchor when one is near). A closed path opens; an open one splits into two paths |
| Knife (K) | Drag across filled shapes: each stretch that crosses one from edge to edge cuts it, with no gap between the pieces. Cuts the selection, or with nothing selected every shape it crosses |
| Eraser (E) | Drag: rubs out a round stroke `eraserSize` wide. Filled shapes lose that area (pieces that come apart become separate paths), outlines are cut under it. Erases from the selection, or every path it reaches |
| Width (W) | Hover a stroke to see its width there; drag outward to add a width point and set the width (the edge follows the pointer; Alt changes one side only); drag a point's diamond to slide it along the path, a handle end to widen it; Alt-drag a diamond to slide a copy; dropping a slid point onto another makes a discontinuous point (the width steps there); click a point to select it, Shift-click to add it to the selection or take it out (dragging one of several selected points moves or widens them all); double-click a point or a stroke to edit its position and side widths numerically; Delete removes the selected points |
| Shape Builder (M) | With paths selected, hover highlights the face under the pointer; click or drag across faces to merge them into one shape, Alt-click or Alt-drag to delete them (and, near a path, the piece of an unfilled open path or the outline edge under the pointer). See [Pathfinder, Shape Builder and paint bucket](#pathfinder-shape-builder-and-paint-bucket) |
| Paint Bucket (B) | Hover highlights the region the visible outlines enclose around the pointer; click fills it with a new path in the current fill |
| Rectangle (R), Ellipse (O), Polygon (Y), Star (S), Line (L) | Drag out a shape (Shift: square / 45°, Alt: from the centre); returns to Select |

Other keys: Delete / Backspace, arrows (Shift = 10), Mod+Z / Mod+Shift+Z, Mod+A, Mod+D, Mod+G / Mod+Shift+G, Mod+J (Join) / Mod+Alt+J (Average), Mod+] / Mod+[ (Alt: to front / back), Mod+= / Mod+- / Mod+0, Space-drag or middle-drag to pan, Mod+wheel to zoom.

Every gesture is one undo step (`Move`, `Scale`, `Draw Rectangle`, `Add Point`, `Close Path`, …), recorded in the controller's `HistoryManager` (pass `history` to share one with the rest of the app). `Escape` during a drag puts everything back.

The selection box follows the selection's rotation when every selected node shares one (`state.selectionFrame.angle`); its resize handles, `scale` and `flip` act along those rotated axes, and `setRotation(degrees)` turns each node to an absolute angle. `state.selectionBounds` stays the axis-aligned box used by align and distribute.

Programmatic API, all undoable: `setRotation`, `addShape`, `addPath`, `addNode`, `updateNode`, `setStyle`, `setWidthProfile`, `setWidthPoint`, `removeWidthPoint` / `removeWidthPoints`, `selectWidthPoints`, `removeNodes`, `translate`, `scale`, `rotate`, `flip`, `transform(matrix)`, `align`, `distribute`, `arrange`, `group`, `ungroup`, `duplicate`, `booleanOp('union' | 'subtract' | 'intersect' | 'exclude')`, `pathfinder('divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack')`, `shapeBuilder(points, { erase })`, `fillRegion(point, { gap })`, `combine`, `breakApart`, `moveAnchor`, `moveHandle`, `convertAnchors`, `insertAnchorAt`, `deleteAnchors`, `setClosed`, `reversePaths`, `copy` / `cut` / `paste` (JSON text, or SVG markup on paste), `loadSvg`, `importSvg`, `setDocument`, `setArtboard`. Viewport: `zoomAt`, `zoomToFit`, `panBy`, `setViewport`, `screenToDocument`, `documentToScreen`.

## Live corners

Any corner anchor (not smooth, not the end of an open subpath, where two straight or curved sides meet at an angle) can carry a radius: `anchor.corner = { radius, kind }`, with `kind` `round` (default), `inverted` (an arc centred on the corner, cut into the shape) or `chamfer` (a straight bevel). The stored anchor stays sharp. `expandVectorCorners(subpaths)` is the one helper that draws the cut geometry, and `subpathsToBezier` calls it, so rendering, hit-testing, bounds, booleans, Outline Stroke, knife / eraser and SVG export all see the same rounded shape (`subpathsToBezier(subpaths, { corners: false })` gives the sharp outline).

- Each side is trimmed by arc length, `r / tan(angle / 2)` from the corner, and a radius that does not fit shrinks so the cut takes at most half of each side (neighbouring corners at their largest meet without overlapping). `vectorCorners(subpaths)` lists the corners with their angle and `maxRadius`.
- A round cut is one cubic with handles `4/3 · tan(φ/4) · ρ` along the sides' directions at the cut (φ the turn, ρ the radius of the circle through both ends): a true arc at any angle (within 0.03 % of the radius at 90°), tangent to curved sides too.
- The rectangle, polygon and star tools (and `addShape` / `vector.addShape` with `cornerRadius`, and `<rect rx>` on import) set radii on sharp anchors instead of baking curves, so corners stay editable. `rectSubpath(bounds, radius, kind)` and `setSubpathCorners(subpath, radius, kind)` do the same in code; `defaults.cornerRadius` / `defaults.cornerKind` apply to new shapes.
- `setCornerRadius(radius, { kind, refs, ids })` and `setCornerKind(kind, …)` change the selected points' corners with the direct tool, else every corner of the selected paths. Scaling a node keeps its radii.
- **Corner widgets**: with the direct tool, each editable path shows a widget inside its selected corners (every corner when none of its points is selected), on the bisector at the arc's centre and at least 10 px in; corners with a side shorter than 30 px on screen hide theirs. Drag one to set the radius of all shown corners (it follows the pointer along the bisector, up to fully round; status `R …`), Alt-click to cycle round → inverted → chamfer, click to pick that corner alone. `getVectorCornerWidgets(state)` and `getVectorOverlayRenderData(state).cornerWidgets` give their positions.

## Stroke alignment and arrowheads

```ts
editor.setStyle({ strokeAlign: "inside" });                              // center (default) | inside | outside
editor.setStyle({ startArrow: "circle", endArrow: "triangle", arrowAlign: "tip", endArrowScale: 1.5 });
editor.outlineStroke();                                                   // the stroke as a filled path
```

- **Alignment** applies to shapes whose subpaths are all closed (open paths stroke centred). An inside stroke is a stroke of twice the width intersected with the fill, an outside one twice the width minus the fill. The canvases draw it as the fill, then the double-width stroke clipped to the shape (`<clipPath>`) or masked by it (`<mask>`); hit-testing checks the side of the outline; `vectorStrokeOutline(node)` / `vectorStrokeOutlinePath(path, style)` give the exact painted area with `outlineStroke` and `pathBoolean`.
- **Arrowheads** (`triangle`, `arrow`, `open`, `circle`, `square`, `bar`) go on the start of the first subpath and the end of the last one, when open. A head is 4 × its weight long and wide, the weight being the stroke width × `startArrowScale` / `endArrowScale` (default 1). On a variable-width stroke the width is the profile's just before the head (the mean of its two sides at that end, `t` = 0 or 1), with the stroke width as a floor: a stroke that tapers to nothing still gets a full-size head, one that swells to 3× gets a 3× head (`arrowheadWeight(style, end)`). With `arrowAlign: "extend"` (default) the tip sits past the end point and the path keeps its length; with `tip` the tip sits on the end point and the stroke is shortened under the head. Either way the stroke stops under the head (`arrowheadInset`): halfway into solid heads, at the chevron's inner corner, far enough that a round or square cap stays behind the tip. Heads are filled with the stroke's paint. `vectorStrokeParts(path, style)` returns the alignment, the (shortened) line, the draw width and each head's outline, tip and direction.
- **Outline Stroke** (`outlineStroke({ ids })`, the toolbar's ⊡ button, `vector.outlineStroke`) replaces each stroke with a filled path of the area it paints — alignment, joins, caps, dashes, corners and heads included — above a copy of the path that keeps the fill.
- `getVectorSelectionStyle(state)` reports `strokeAlign`, the arrow fields, `cornerRadius` / `cornerKind` / `corners` and `hasOpenPath`, with `mixed` flags; the style panels show Align, Start / End heads with their scale, Heads (tip past end / at end) for open paths, and Corners (radius and kind).

## Variable-width strokes

```ts
editor.setWidthProfile("taperEnd");                       // a preset
editor.setWidthProfile([{ t: 0, left: 0, right: 0 }, { t: 0.3, left: 2, right: 1 }, { t: 1, left: 1, right: 1 }]);
editor.setWidthProfile({ taper: { startLength: 0.2, endLength: 0.4 }, wave: { amount: 0.3, cycles: 6 } });
editor.setWidthProfile("uniform");                        // or setStyle({ strokeWidthProfile: null })
```

- **Model.** `strokeWidthProfile` is a list of `{ t, left, right }` points: `t` is the position along each subpath by length (0–1; every subpath gets the same profile), `left` / `right` how far the stroke reaches on each side as multiples of half the stroke width (1 = uniform; left is left looking along the path on screen, y down). Each side is interpolated with a monotone cubic (`widthProfileAt`, after figcraft), so the width never overshoots its points, and held flat before the first and after the last point; two points at one `t` make a step. Presets (`VECTOR_WIDTH_PRESETS`): `uniform`, `taperStart`, `taperEnd`, `taperBoth`, `bulge`, `pinch`, `teardrop`, `wave`, `pressure`; `generateWidthProfile({ taper, wave })` samples effectcraft's parametric taper and wave. Reversing a path reverses its profile; mirroring swaps its sides.
- **Outline.** `variableStrokeOutline(path, { width, profile, cap, join, dash })` builds the exact stroke (effectcraft's union of trapezoids per flattened segment, wedges at bends and caps, filled non-zero — emitted as the boundary they add up to and normalised with the polygon boolean engine) and refits each ring with cubics to within `tolerance` (default 0.05): a Bézier outline, not a polyline. Caps and joins follow the style at the path's own vertices (curves bend round), dashes are cut along the same arc length the profile follows, live corners and `tip` arrowheads shorten the line it runs along, and inside / outside alignment uses the double-width profile clipped by the shape. Arrowheads are sized from the profile's width at their end, never below the stroke width (see Arrowheads above).
- **Rendering and hit-testing.** A profiled stroke renders through `strokeParts` with `outline` set: fill that path with the stroke paint (clipped or masked like an aligned stroke) instead of stroking `d`; parts are cached per node object. Hit-testing compares the distance to the centre line with the side width at the nearest point. `vectorStrokeOutline` / Outline Stroke bake it into a filled path.
- **SVG.** Export writes `<path data-vector-part="stroke-outline">` inside the `<g data-vector-path>` with `data-vector-width-profile="t,left,right;…"` (and the cap, join and dashes as `data-vector-stroke-*`), so import restores the profile on the original path.
- **Width tool (W)** — see the tool table. `getVectorWidthHandles(state)` gives the width points in document units; the overlay has `widthPoints` (diamond, side ends, selected / hovered / active) and `widthSpot` (the dashed preview where a drag would add one), drawn by both canvases with `vectorDiamondPath`. `state.selectedWidthPoints` lists the selected points (all on one path; `selectWidthPoints(refs)` sets them, `removeWidthPoints()` deletes them as one undo step). Moving several re-sorts the profile and the selection follows the points; a single slid point stays between its neighbours, but lands exactly on one it is dropped onto (within the hit radius), making a step.
- **Width Point Edit.** A double-click with the width tool sets `state.widthPointEdit` — `{ nodeId, subpath, index, t, left, right, point }`, with `index` null on a stroke spot away from points and `left` / `right` side widths in document units — and both canvases show `<VectorWidthPointEditor>` beside the point (in a `<foreignObject data-vector-width-point-edit>`; position in percent, left and right widths; Enter / Apply, Escape / Cancel). Headless: `openWidthPointEdit(target)`, `commitWidthPointEdit({ t, left, right })`, `closeWidthPointEdit()`, or `setWidthPoint({ nodeId, index? }, { t, left, right })` directly (no `index` adds a point at `t`; a new `t` may pass other points, and onto another point's `t` makes a step). Undo, Escape and switching tools close the editor.
- **Pencil pressure.** `toVectorPointerInput` passes `PointerEvent.pressure` and `pointerType`; with `editing.pencilPressure` `pen` (default) pen strokes get a profile of pressure ÷ 0.5 (so half pressure draws the stroke width), simplified with `pressureWidthProfile`. The lift's zero pressure is ignored.
- `getVectorSelectionStyle` reports `strokeWidthProfile` and `widthProfile` (a preset id, `uniform` or `custom`, with `mixed.widthProfile`); both style panels have a Profile picker and a reset-to-uniform button.

## Path editing

All path editing happens in each node's own space: pointer positions go through the node's world matrix first, so rotated nodes and nodes in rotated groups edit exactly. Every gesture and action is one undo step.

```ts
const editor = new VectorEditorController({
  editing: { keepShapeOnDelete: true, curvatureMoves: false, pencilSmoothing: 0, recognizeShapes: false, eraserSize: 10 },
});
editor.setEditing({ curvatureMoves: true, pencilSmoothing: 0.4 });
```

| Action | What it does |
| :--- | :--- |
| `deleteAnchors(refs, { keepShape })` | Deletes points without opening the path. With `keepShape` (default `keepShapeOnDelete`, on) the two neighbours keep their handle directions and their facing handles are refitted so one cubic follows the two old segments with the least error; two straight segments become one; an end of an open path drops its segment. Off, the neighbours are joined with their handles as they are |
| Segment drag / `bendSegment(ref, to, t)` | Bends a segment so the curve passes through the pointer at the grabbed parameter: both handles go to the chord's thirds plus one shared offset, `B(t) = L(t) + 3t(1 − t)·offset` (t clamped to 0.05–0.95). Smooth end points stay smooth |
| Curvature move / `moveAnchor(ref, to, { curvature: true })` | Only the two segments at the point change: the neighbours' facing handles keep their direction and scale with their chords, a smooth point turns along the line through its neighbours, a corner keeps its handles (or none) |
| `joinPaths({ ids, tolerance })` | Joins open subpaths nearest endpoints first (ends within `tolerance`, default the pick distance, merge; others get a straight segment); a single open subpath is closed. The lowest path keeps its id, style and space |
| `averageAnchors(axis)` | Moves the selected points to their average y (`horizontal`), x (`vertical`) or point (`both`), in document space |
| `removeRedundantPoints({ tolerance })` | Drops collinear and duplicate points and smooth joints one cubic can replace within `tolerance` (default 0.5) |
| `smoothPaths({ amount, refs })` | Pulls handles towards Catmull-Rom-like tangents (a third of the way to each neighbour); only the selected points with the direct tool |
| `cutPathAt(id, point)` / `cutAtAnchors(refs)` | Scissors |
| `knife(points, { ids })` | Knife. Crossings are exact (line–cubic roots); each chord splits the loop it starts and ends on into two loops sharing it, or joins an outline to a hole first (a ring cut once becomes a C shape; cut twice, two pieces). A stroke that starts or ends inside a shape does not cut there |
| `erase(points, { ids, size })` | Eraser: the stroke's area (`outlineStroke` with round caps and joins) is subtracted from filled closed paths; outlines are cut at their exact intersections with it and keep the original curves |

The pencil's lazy mouse is a pulled string up to 100 screen pixels long (`pencilSmoothing` × 100): the pen moves only when the pointer pulls the string tight, and catches up at the end of the stroke. With `recognizeShapes`, a stroke that stays close to a straight chord becomes a line, and a closed one an ellipse (points on the inscribed ellipse), a rectangle (four upright corners) or a polygon of up to eight corners; nearly square boxes become squares and circles. The pure functions are exported too: `removeAnchorKeepingShape`, `bendSegment`, `curvatureMoveAnchor`, `cutSubpathAt`, `splitSubpathAt`, `joinSubpaths`, `smoothSubpath`, `removeRedundantPoints`, `knifePath`, `eraserRegion`, `eraseFromFill`, `eraseFromOutline`, `splitIntoFaces`, `LazyMouse` and `recognizeInkShape`.

## Pathfinder, Shape Builder and paint bucket

All three work in document space: every path goes through its own transform and its groups', with live corners cut, so rotated nodes and nodes in rotated groups take part as drawn, and results are mapped back into the space of the node that receives them.

**Pathfinder.** `pathfinder(op, { ids })` runs over the selected (or given) paths, bottom to top, and returns the new path ids:

| Operation | Result |
| :--- | :--- |
| `divide` | Every face of the overlapping shapes becomes its own path, painted like the top-most shape covering it. Unfilled open paths cut the faces they cross |
| `trim` | Hidden parts are removed: one path per shape that stays visible, nothing merged |
| `merge` | Like Trim, then touching or overlapping visible parts of shapes with the same fill are joined |
| `crop` | The top shape crops the others: it goes, and the visible parts of the shapes below inside it stay |
| `outline` | Every outline is cut into open strokes where it meets another, stroked in the fill of the shape it bounds (the top-most where outlines coincide) |
| `minusBack` | The top shape minus everything below it |

A filled path takes part as its fill (every subpath closed); an unfilled path with a stroke takes part as the area its stroke paints — alignment, caps, joins and arrowheads included — and results from it are filled with the stroke's paint. Results keep the style of the shape whose area they are and replace the operands at the place of the top-most one, in a group named after the operation when there are several. The core is `pathfinder(op, shapes)` in `@pixerate/editor/canvas`: one arrangement of all shapes (`dividePaths` / `pathBooleanSelect`, which knows the shapes covering every area), so each operation is a choice of areas per result, and curves stay exact.

**Shape Builder.** Select two or more shapes and pick the Shape Builder (M). The selected paths divide the plane into faces (a `PlanarMap`): closed subpaths bound faces whatever their paint, so a stroke-only shape's inside is a face; filled open subpaths that enclose an area are closed by an invisible edge; unfilled open paths cut the faces they cross, and an area only outlines enclose is a face too. Hovering highlights the face under the pointer with a 45° hatch over a translucent fill (`state.builder`, `getVectorOverlayRenderData().builder`); a click or a drag merges every face it touches into one new path, styled like the top-most shape over the first face (with the current fill when only outlines enclose it); Alt deletes them instead, and Alt near a path deletes the piece of it between the points where other paths meet it, whichever of an unfilled open path's piece and another outline's edge is nearer: an erased edge opens a closed subpath there, splits an open one, or takes a subpath it runs all the way round (a filled open subpath that encloses an area runs round its invisible closing edge, which never comes back as a visible segment). Paths keep their own transforms, and an edge bounding a face deleted in the same gesture goes with that face instead of being cut apart (the highlight shows only the edges cut on their own). Every shape covering a touched face loses that area; pieces of open paths lying between touched faces go too. Faces merge along the map's own edges, so the shared edges drop out exactly with no seam. One gesture is one undo step (`Shape Builder` / `Shape Builder Delete`); the shapes stay selected for the next one. `getShapeBuilderFaces({ ids })` lists the faces (path data, area, a point inside, the ids of the paths filling each) and `shapeBuilder(points, { ids, erase, tolerance })` runs a gesture from document points, returning the counts of `faces`, `lines` and `edges` it took (the `vector.shapeBuilder` command returns them too). `cutOutPiece(path, piece, fillCloses, tol)` and `hatchPath(path, { gap, maxLines })` are the pathops helpers behind it.

**Paint bucket.** `fillRegion(point, { gap })` and the Paint Bucket tool (B) split every visible outline (locked ones included) at its crossings, shoot a ray from the point and trace the face it hits by always taking the sharpest left turn, until a loop that runs round the point comes back; pieces nested in that face (islands) become its holes. The region becomes a new path in the current fill, just below the selection, or on top when nothing is selected. `editing.fillGap` (document units, default 0; the toolbar's Gaps toggle sets `VECTOR_FILL_GAP`) closes gaps up to that size between loose path ends first.

The planar map is exported from `@pixerate/editor/canvas`: `PlanarMap.build(inputs, { gap })` with `faces`, `faceSources(i)`, `faceAt(point)`, `merge(faces)`, `chains()` (the edges joined between junctions) and `regionAt(point)`, plus `planarSplit` (the curves split where they meet) and `interiorPoint`.

## Smart guides and snapping

Drags snap to the other objects in the drawing while `snap.objects` is on (the default), and show labelled smart guides while `snap.guides` is on:

```ts
const editor = new VectorEditorController({
  snap: { objects: true, guides: true, threshold: 5, grid: 0, angles: [0, 45, 90, 135] },
});
editor.setSnap({ grid: 8 });   // the grid catches whatever snaps to no object
editor.toggleSnapping();       // object snapping off / on (the toolbar's "Snap" button)
```

| Gesture | Snaps |
| :--- | :--- |
| Move (select tool) | The selection's bounding box: its edges and centre line up with other objects' edges, centres and anchors' boxes and the artboard; on an axis that lines up with nothing it spaces itself evenly in its row or column (centred between neighbours, or repeating a gap between two others) |
| Resize (selection box) | The dragged handle lands on an anchor or centre, else the moving corner / side lines up with targets — along the box's own axes when it is rotated; a side that lines up with nothing can match another object's width or height |
| Anchors (direct tool) | The grabbed anchor as a point (see below); the other moving anchors, and the segments through them, are no targets |
| Handles, pen points, shape start and corner | As a point, leaving from the anchor (or the shape's start); shapes also match other objects' sizes |

A point snaps, in this order: kept to its Shift constraint (45° steps, a square, or an axis) and slid into line with the nearest target; onto an **anchor** or **centre**; onto an **intersection** of two paths (curve–curve included, every crossing); onto the **perpendicular** foot or a **tangent** point from where it leaves; onto a **path**; onto a construction angle through where it leaves; or **align**ed on x and y with targets. An axis that snaps to nothing still goes to the grid when `grid` is set.

Hold **Cmd / Ctrl** during a drag to bypass snapping. The pull distance is `threshold` screen pixels, so it stays the same at any zoom. Targets are in document space (world matrices and `vectorPathWorldBezier`), so rotated nodes snap exactly, and they are gathered once per gesture and kept sorted by x and y, so each pointer move is a few binary searches. The pen and shape tools snap (and show guides) while hovering too.

`state.guides` holds the guides of the snap in progress in document units: `lines` (`kind`: `align`, `construction`, `spacing` or `size`) and `labels` (`anchor`, `centre`, `intersect`, `perpendicular`, `tangent`, `path`, `align`, gap distances and `W …` / `H …` sizes). For custom tools, `VectorSnapTargets.forMove` / `forResize` / `forDrawing` / `forAnchorDrag` / `forHandle` gather targets and `snapFrom`, `snapRect` and `snapScale` snap with them; `segmentIntersections` (path ops) finds every crossing of two Bézier segments.

## Rendering

`getVectorSceneRenderData(state)` returns the document as SVG-ready paths (with gradient defs) and a `transform` for the document layer; `getVectorOverlayRenderData(state)` returns the overlay in screen pixels: outlines, the selection box with its handles, anchors, handles, the marquee, the pen's rubber band, smart guide lines and labels (`guides`), the knife or eraser stroke being drawn (`toolStroke`), the pencil's lazy-mouse string (`pencilString`), the scissors cut point (`cutPoint`), the live corner widgets (`cornerWidgets`), the width tool's `widthPoints` and `widthSpot`, the Shape Builder / paint bucket highlight (`builder`: faces to fill translucent, `hatches` to stroke over them (45° lines `VECTOR_BUILDER_HATCH_GAP` pixels apart; empty strings for the paint bucket), line pieces and outline edges an erase deletes, the drag's trail; `mode` `merge`, `erase` or `fill`), and a status string. Draw the overlay outside the transformed layer so handles keep their size at any zoom. Scene nodes carry an SVG `transform` when rotated, and the selection box comes unrotated with a `transform` (`rotate(angle cx cy)`) to draw it in — handle `screen` positions are the true on-screen points. A path whose stroke is aligned or has arrowheads carries `strokeParts`: draw `d` with the fill only, then `strokeParts.d` at `strokeParts.width` with its `clip` (a `<clipPath>` of the shape for inside, a user-space `<mask>` over `clip.bounds` that hides the shape for outside), then each head filled with the stroke; a variable-width stroke has `strokeParts.outline` instead, filled with the stroke paint under the same clip. The canvases group them under the node's id as `<g data-vector-id data-vector-stroke-align>` with `data-vector-part="fill" | "stroke" | "stroke-outline" | "head"` children. The bundled React and Svelte canvases are thin renderers over these two functions.

## SVG

```ts
import { parseVectorSvg, vectorDocumentToSvg } from "@pixerate/editor/vector";

const doc = parseVectorSvg(markup);        // DOM-free: path, rect, circle, ellipse, line, polyline, polygon, g,
                                           // linear / radial gradients, style attributes and transforms
const svg = vectorDocumentToSvg(doc);      // standalone SVG with <defs> for gradients
```

Live corners export as their rounded outline plus `data-vector-d` (the sharp path) and `data-vector-corners` (`subpath.index:radius[:kind]`), so the editor's own SVG imports with editable corners. Inside / outside strokes and arrowheads, which SVG cannot express, export as a `<g data-vector-path>` holding the fill, the double-width stroke with a `<clipPath>` or `<mask>`, and the heads as filled paths; a variable-width stroke exports as its filled outline with `data-vector-width-profile` (`vectorDocumentToSvg(doc, { strokes: "outline" })` writes one filled outline of the stroke instead); import merges such a group back into one path with its alignment, heads and real stroke width.

On import each shape's transform is split: its rotation becomes the node's `transform` and any scale or skew is baked into the anchors (stroke widths are scaled by the transform's average scale). Export writes rotated nodes with `transform="matrix(…)"`. Text, images, clip paths, masks, filters and `<use>` are skipped.

## React

```tsx
import { VectorEditor, useVectorEditorController, useVectorCommands } from "@pixerate/editor-react/vector";

function Drawing() {
  const controller = useVectorEditorController({ document: doc });
  useVectorCommands(registry, controller); // optional: palette and agent commands
  return <VectorEditor controller={controller} height={520} />;
}
```

`<VectorCanvas>` (smart guides drawn in `guideColor`), `<VectorToolbar>` (with a snapping toggle, `showSnap`, and a path-editing group, `showPathEdit`: Join, Average, Cut at Points, Remove Redundant Points, Smooth, Outline Stroke, the Keep shape / Curvature / Shapes toggles, and the pencil smoothing and eraser size inputs and the paint bucket's Gaps toggle while those tools are active; the Combine group is followed by a Pathfinder group with Divide, Trim, Merge, Crop, Outline and Minus Back) and `<VectorStylePanel>` (fill, stroke, width, alignment, width profile, arrowheads, corner radius and kind, opacity) can be used on their own; the canvas draws corner widgets with the direct tool and the Shape Builder / paint bucket faces (`data-vector-builder-face`, hatched with `data-vector-builder-hatch`, erased pieces as `data-vector-builder-line`); `useVectorEditor` / `useVectorEditorState` give the state.

## Svelte

```svelte
<script lang="ts">
  import { VectorEditorController } from "@pixerate/editor/vector";
  import { VectorEditor, useVectorCommands } from "@pixerate/editor-svelte/vector";
  const controller = new VectorEditorController({ document: doc });
  useVectorCommands(registry, controller);
</script>

<VectorEditor {controller} height={520} />
```

`createVectorEditor(controllerOrOptions)` exposes the state reactively (call `destroy()` when done). `<VectorCanvas>` takes `guideColor` and `<VectorToolbar>` `showSnap` and `showPathEdit`, as in React. Both toolbars build the path-editing group from `VECTOR_PATH_ACTIONS` and `VECTOR_EDIT_TOGGLES`, and the Pathfinder group from `VECTOR_PATHFINDER_ACTIONS`.

## Agent commands

`createVectorCommands(controller)` returns `vector.list`, `vector.select`, `vector.addShape`, `vector.addPath`, `vector.setStyle` (fill, stroke, width, caps, joins, dashes, fill rule, `strokeAlign`, `startArrow` / `endArrow`, `arrowAlign`, `startArrowScale` / `endArrowScale`, `strokeWidthProfile`), `vector.setWidthProfile` (a `preset`, `points`, or a parametric `taper` / `wave`), `vector.setWidthPoint` (one point by `index`, or a new one at `t`; side widths in document units), `vector.setCorners` (radius and / or kind of anchors or paths), `vector.outlineStroke`, `vector.transform`, `vector.delete`, `vector.boolean`, `vector.pathfinder`, `vector.shapeBuilderFaces`, `vector.shapeBuilder`, `vector.fillRegion`, `vector.align`, `vector.distribute`, `vector.arrange`, `vector.group`, `vector.ungroup`, `vector.deleteAnchors`, `vector.moveAnchor`, `vector.bendSegment`, `vector.join`, `vector.average`, `vector.removeRedundantPoints`, `vector.smooth`, `vector.cut`, `vector.knife`, `vector.erase`, `vector.setEditing`, `vector.setTool`, `vector.exportSvg` and `vector.importSvg`. Register them in a `CommandRegistry` and `createCommandToolProvider` exposes them as agent tools.
