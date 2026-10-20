# Vector editor

`@pixerate/editor/vector` is a headless vector drawing editor: a document of Bézier paths and groups, the select / direct-select / pen / pencil / shape tools, transforms, boolean operations (destructive or live), non-destructive path effects, live blends and path morphing, alignment, grouping, undo, SVG import and export, and agent commands. It has no DOM or third-party imports, so it runs in the browser, Node.js and workers. React (`@pixerate/editor-react/vector`) and Svelte (`@pixerate/editor-svelte/vector`) add the same hooks / runes and an SVG canvas, toolbar and style panel.

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
- A **text** node sets `text` in a `frame` (point, area or a path) with a base `font`, optional styled `runs` and a `paragraph` style, and paints with the same fills and strokes as a path (see [Text](#text)).
- An **instance** draws a symbol of the document (`symbols`) through its `transform`, which, unlike other nodes', may scale and skew (see [Symbols and instances](#symbols-and-instances)).
- A **group** selects and transforms its children together. Nodes can be hidden (`visible: false`) or locked (drawn, not pickable).
- Paths and groups can carry an **effect stack** (`effects`, see [Path effects](#path-effects)), and a group can be a **live boolean** (`liveBoolean`, see [Live booleans](#live-booleans)).
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
| Blend (J) | Click a shape, then another: they become a live blend (one undo step). Clicking an anchor of a path's first subpath starts the blend there. Click on from a blend to add the next shape as a key; Escape or a click on empty canvas forgets the first click. See [Blends](#blends) |
| Gradient (G) | Drag across the selection (or a shape, selecting it) to set its fill's gradient vector (the stroke's after `setGradientTarget('stroke')`); a colour becomes a gradient from it to white. Drag the start (centre) handle or the bar to move the gradient, the end (radius) handle to turn and size it (Shift: 45° steps), the aspect handle to squash it, and a radial gradient's focal point (Alt-drag the centre while they coincide). Click the bar to add a stop, drag a stop along it (or off it to delete it), drag a midpoint diamond; Delete removes the selected stop. One undo step per gesture. See [Gradients](#gradients) |
| Envelope (U) | With an object that has an envelope selected, shows its mesh: drag an anchor (it takes its handles along), a handle (the opposite handle turns with it, so the grid line stays smooth through the anchor), or anywhere inside a patch to pull the surface there (the outer border stays put unless the grab is near it; the corners never move). A warp preset becomes a mesh of its rows × columns when first dragged. Click another object to pick it. One undo step per drag. See [Distort and envelopes](#distort-and-envelopes) |
| Rectangle (R), Ellipse (O), Polygon (Y), Star (S), Line (L) | Drag out a shape (Shift: square / 45°, Alt: from the centre); returns to Select |

Other keys: Delete / Backspace, arrows (Shift = 10), Mod+Z / Mod+Shift+Z, Mod+A, Mod+D, Mod+G / Mod+Shift+G, Mod+J (Join) / Mod+Alt+J (Average), Mod+] / Mod+[ (Alt: to front / back), Mod+= / Mod+- / Mod+0, Space-drag or middle-drag to pan, Mod+wheel to zoom.

Every gesture is one undo step (`Move`, `Scale`, `Draw Rectangle`, `Add Point`, `Close Path`, …), recorded in the controller's `HistoryManager` (pass `history` to share one with the rest of the app). `Escape` during a drag puts everything back.

In **Free Distort** mode (`setFreeDistort(true)`, `state.freeDistort`, the toolbar's Distort toggle) the selection box's handles distort instead of scaling: see [Distort and envelopes](#distort-and-envelopes).

The selection box follows the selection's rotation when every selected node shares one (`state.selectionFrame.angle`); its resize handles, `scale` and `flip` act along those rotated axes, and `setRotation(degrees)` turns each node to an absolute angle. `state.selectionBounds` stays the axis-aligned box used by align and distribute.

Programmatic API, all undoable: `setRotation`, `addShape`, `addPath`, `addNode`, `updateNode`, `setStyle`, `setWidthProfile`, `setWidthPoint`, `removeWidthPoint` / `removeWidthPoints`, `selectWidthPoints`, `removeNodes`, `translate`, `scale`, `rotate`, `flip`, `transform(matrix)`, `align`, `distribute`, `arrange`, `group`, `ungroup`, `duplicate`, `booleanOp('union' | 'subtract' | 'intersect' | 'exclude', { live })`, `skew`, `distort`, `setFreeDistort`, `envelope`, `makeEnvelopeWithTopObject`, `releaseEnvelope`, `addEffect`, `updateEffect` (with `{ merge }` for slider drags, ended by `endMergedEdit`), `moveEffect`, `removeEffect`, `expandAppearance`, `blend`, `setBlendOptions`, `addBlendKey`, `replaceBlendSpine`, `expandBlend`, `releaseBlend`, `pathfinder('divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack')`, `shapeBuilder(points, { erase })`, `fillRegion(point, { gap })`, `combine`, `breakApart`, `moveAnchor`, `moveHandle`, `convertAnchors`, `insertAnchorAt`, `deleteAnchors`, `setClosed`, `reversePaths`, `copy` / `cut` / `paste` (JSON text, or SVG markup on paste), `loadSvg`, `importSvg`, `setDocument`, `setArtboard`. Viewport: `zoomAt`, `zoomToFit`, `panBy`, `setViewport`, `screenToDocument`, `documentToScreen`.

## Live corners

Any corner anchor (not smooth, not the end of an open subpath, where two straight or curved sides meet at an angle) can carry a radius: `anchor.corner = { radius, kind }`, with `kind` `round` (default), `inverted` (an arc centred on the corner, cut into the shape) or `chamfer` (a straight bevel). The stored anchor stays sharp. `expandVectorCorners(subpaths)` is the one helper that draws the cut geometry, and `subpathsToBezier` calls it, so rendering, hit-testing, bounds, booleans, Outline Stroke, knife / eraser and SVG export all see the same rounded shape (`subpathsToBezier(subpaths, { corners: false })` gives the sharp outline).

- Each side is trimmed by arc length, `r / tan(angle / 2)` from the corner, and a radius that does not fit shrinks so the cut takes at most half of each side (neighbouring corners at their largest meet without overlapping). `vectorCorners(subpaths)` lists the corners with their angle and `maxRadius`.
- A round cut is one cubic with handles `4/3 · tan(φ/4) · ρ` along the sides' directions at the cut (φ the turn, ρ the radius of the circle through both ends): a true arc at any angle (within 0.03 % of the radius at 90°), tangent to curved sides too.
- The rectangle, polygon and star tools (and `addShape` / `vector.addShape` with `cornerRadius`, and `<rect rx>` on import) set radii on sharp anchors instead of baking curves, so corners stay editable. `rectSubpath(bounds, radius, kind)` and `setSubpathCorners(subpath, radius, kind)` do the same in code; `defaults.cornerRadius` / `defaults.cornerKind` apply to new shapes.
- `setCornerRadius(radius, { kind, refs, ids })` and `setCornerKind(kind, …)` change the selected points' corners with the direct tool, else every corner of the selected paths. Scaling a node keeps its radii.
- **Corner widgets**: with the direct tool, each editable path shows a widget inside its selected corners (every corner when none of its points is selected), on the bisector at the arc's centre and at least 10 px in; corners with a side shorter than 30 px on screen hide theirs. Drag one to set the radius of all shown corners (it follows the pointer along the bisector, up to fully round; status `R …`), Alt-click to cycle round → inverted → chamfer, click to pick that corner alone. `getVectorCornerWidgets(state)` and `getVectorOverlayRenderData(state).cornerWidgets` give their positions.


**Corner smoothing.** `corner.smoothing` (0–1, `setCornerRadius(r, { smoothing })` or `setCornerSmoothing`) turns a round corner between straight sides into a squircle: the cut starts `(1 + smoothing)` times as far along each side, eases in with a cubic whose second handle is where the arc's tangent meets the side, and follows a circular arc over the rest of the turn (figma-squircle's profile, generalised from 90° to any angle). Smoothing shrinks before the radius when the corner does not fit. The arc's ends become two more drawn anchors.
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

## Blends

`blend({ ids, spacing, steps, distance, orientToSpine, linear })` (the toolbar's ⧓, or the Blend tool) turns two or more paths or groups that share a parent into a **live blend group**: a group whose `blend` holds the options and whose children are the keys (bottom to top) with generated in-betweens between them. Steps are children with `blendStep: true` and `locked: true` (a click selects the blend), ids `<blend id>~1`, `~2`, …; they are rebuilt whenever a key or the options change — moving or editing a key with any tool, mid-drag included — so edits are always to the keys. Every blend gesture is one undo step (`Blend`, `Blend Options`, `Replace Spine`, `Expand Blend`, `Release Blend`).

| Spacing | Steps between two keys |
| :--- | :--- |
| `steps` (default, `steps: 5`) | That many |
| `distance` (`distance: 20`) | One every `distance` along the spine (`round(length / distance) − 1`) |
| `smoothColor` | One per two levels of the largest colour-channel difference between the keys' fills and strokes (at most 256); when the colours match, one per two units of distance |

- **Spine.** Steps sit on the straight lines between the keys' centres. `replaceBlendSpine()` with a blend and a path selected makes the path's first subpath the spine (stored in the group's space, the path is removed) and moves the keys onto it, spread evenly by arc length; each step is then moved by how far the spine bends away from the chord between its two keys, so steps follow the curve and keys stay where they are. `orientToSpine` also turns each step by how much the spine's direction there differs from the keys' (keys keep their orientation). Transforming the blend carries its spine.
- **Expand** (`expandBlend`) turns blends into plain groups of keys and steps (steps get fresh ids and become editable); **Release** (`releaseBlend`) puts the keys back in the blend's place, plus a replaced spine as an unpainted path. Ungrouping a blend expands it.
- The overlay draws each selected blend's spine dashed with a dot where each key sits (`getVectorOverlayRenderData().blend.spines`), and, with the Blend tool, the first pick (`blend.start`) and the anchors of the path under the pointer (`blend.anchors`). `getVectorBlendControls(state)` says what the controls show (the selected blends, their options or the defaults for new blends from `setBlendDefaults`, whether Blend and Replace Spine can run) and `applyVectorBlendOptions(controller, patch)` applies a control's change to both.

**Morphing.** The in-betweens come from `createVectorMorph(a, b, options)` (prepare once, `at(t)` per step) or `interpolateVectorPaths(a, b, t, options)`, which work on any two nodes and are pure:

1. Live corners are cut into the geometry; both shapes are taken in their parent's space (their own transforms applied), and every segment becomes a cubic (lines with handles at thirds, so a line bends smoothly into a curve).
2. Contours pair in order; one without a partner grows out of a point at the same place relative to the other shape's box, so a hole appears or closes. Groups pair their paths in stacking order the same way.
3. Each pair gets the same number of segments (at least `minSegments`, 16; `spacing` caps the distance between anchors; at most `maxSegments`, 400): new anchors go to segments in proportion to their arc length, each split by de Casteljau at equal arc length, so the outlines are unchanged.
4. Closed shapes keep the same winding (the second runs backwards when their areas' signs differ, for every contour, so nonzero holes stay holes); open paths take the direction that costs less. The closed side of each pair is restarted at the anchor that costs least: what remains after the best-fit rotation and scale (both centred and scaled to unit RMS radius), a little for how far that rotation turns, and the χ² distance of log-polar shape-context histograms measured from the contour's direction. So a turned copy of a shape matches by turning. `starts: [a, b]` (the Blend tool's clicks) pins the first subpath's starts instead; an open path clicked at its end runs backwards.
5. In-betweens follow the best-fit similarity (Procrustes) interpolated — rotation θ·t, scale sᵗ, centroid moving straight — plus `t` of what it leaves over, mixed with straight-line anchor paths by `rigidity` (default 1; `linear: true` gives straight lines only). A shape that turns keeps its area through the morph instead of collapsing.
6. The rigid `transform` interpolates as a rotation (the shorter way) plus a translation (`interpolateRigidMatrix`), and the geometry is mapped into it. Straight runs come out as lines without extra anchors; a pair of one closed and one open contour is open in between.
7. Paint (`interpolateVectorStyle`, `interpolateVectorPaint`): colours mix in OKLab with premultiplied alpha, a missing paint fades in from transparent, gradients of one style mix stop by stop (midpoints too) or resample their stops at every offset where either bends (`resampleGradientStops`, through each gradient's midpoints and colour space), and mix angle or centre / radius, or their start / end / width / focal points when both are explicit, a colour and a gradient go through a gradient of that colour; stroke width, opacity, dashes (a solid stroke counts as the other's pattern with its gaps closed), arrowhead scales and width profiles (`interpolateWidthProfiles`, at every `t` either has) interpolate; caps, joins, the fill rule, alignment and arrowheads switch halfway.

For animation, `evaluateVectorPathKeyframes([{ time, value: node, easing }], time)` returns the shape of a path track at a time, morphing between the keyframes either side (each pair prepared once and cached) with the animation package's easings (`hold` included). The building blocks are exported too: `subpathToMorphContour`, `refineMorphContour`, `turnMorphContour`, `reverseMorphContour`, `correspondMorphContours`, `interpolateMorphContours`, `morphContourToSubpath` and `morphPathsCross` (how many anchor paths cross — a correspondence check), and for blend groups `generateVectorBlendChildren`, `refreshVectorBlends`, `vectorBlendStepCount`, `vectorBlendSpine`, `expandVectorBlend` and `releaseVectorBlend`.

## Path effects

A path or group can carry an ordered stack of live path effects — After Effects' path operators — that change what it draws while its anchors (or children) stay editable:

```ts
const [id] = controller.addEffect("zigzag", { ids: ["wave"], params: { size: 6, ridges: 4, smooth: true } });
controller.updateEffect("wave", id, { params: { size: 8 } }, { merge: true }); // a slider drag: one undo step…
controller.endMergedEdit();                                                    // …until it ends
controller.addEffect("repeater", { ids: ["wave"], params: { copies: 5, rotation: 15, endOpacity: 20 } });
controller.expandAppearance({ ids: ["wave"] });                                // bake into plain paths
```

Each entry is `{ id, type, enabled?, params }` (`VectorEffect`); `createVectorEffect(type, id, params)` fills in the defaults (`VECTOR_EFFECT_DEFAULTS`) and `VECTOR_EFFECT_PARAM_SPECS` describes each parameter for a panel. Lengths are in the node's own units, angles in degrees, percentages 0–100.

| Type | Parameters | What it does |
| --- | --- | --- |
| `trim` (Trim Paths) | `start`, `end` (%), `offset` (°), `mode` | Keeps the part between start and end. `simultaneous`: every path by the same fractions of its own length; `individual`: the paths laid end to end in stacking order and trimmed as one length. Crossing the start of a closed path stays one piece |
| `roundCorners` | `radius` | A circular arc of that radius at every corner (the live-corner maths: exact at any angle, shrunk to fit short sides); smooth points and open ends are kept |
| `puckerBloat` | `amount` (−100…100 %) | Bloat moves the points towards their mean and the handles away (bulging segments); pucker the opposite (spikes) |
| `twist` | `angle`, `center` | Turns the paths about the middle of their bounds (plus `center`), by 0 at the centre up to `angle` at the farthest point |
| `zigzag` | `size`, `ridges`, `smooth` | Each segment split into `ridges + 1` equal pieces, points pushed alternately `size` to either side (a closed path of n segments gets `n·(ridges + 1)` points) |
| `wiggle` (Wiggle Paths) | `size`, `detail`, `smooth`, `speed`, `correlation`, `phase`, `seed`, `time` | Points moved by smooth value noise up to `size`; deterministic for the same seed and parameters (`time` is a plain parameter in seconds, so animating it animates the wiggle) |
| `offset` (Offset Paths) | `amount`, `join`, `miterLimit`, `copies`, `copyOffset` | Grows or shrinks the shapes (`offsetPath`); copy i is offset by `amount · (i + 1 + copyOffset)` |
| `merge` (Merge Paths) | `mode`: `merge`, `add`, `subtract`, `intersect`, `exclude` | Combines the shapes above it into one (a compound path, or a boolean), painted in the bottom shape's style |
| `envelope` | `style`, `bend`, `horizontal`, `vertical` (%), `orientation`, `rows`, `columns`, `mesh` | Envelope distortion: the paths are mapped from their combined bounds through a warp preset or a Bézier mesh. See [Distort and envelopes](#distort-and-envelopes) |
| `repeater` | `copies`, `offset`, `position`, `anchor`, `rotation`, `scale` (%), `startOpacity`, `endOpacity` (%), `composite` | Copy i is `translate(position·k) · rotate(rotation·k) · scale^k` about the anchor (the middle of the shapes' bounds plus `anchor`), `k = i + offset`; opacity runs from start to end across the copies, a fractional copy count fades the last copy, and `below` draws each copy under the one before it (`above`: over it) |

**Stacking** follows After Effects' shape layers: an effect acts on every path above it — the node's own outline (live corners cut), or for a group all its children's paths as they draw (nested groups and their own effects included) — in stack order, and effects placed after a repeater act on its copies (a Trim Paths after a repeater trims across the copies; Merge Paths after it makes one shape of them). Disabled effects are skipped.

**One place.** `expandVectorAppearance(node)` evaluates a node's effects (and live booleans) into plain path nodes, cached per node object, so an edit recomputes only the nodes it replaced. Rendering, hit-testing (`hitTestVectorNode`), bounds (`vectorNodeBounds`, the selection box), snapping targets, `booleanOp`, `combine`, the Pathfinder, Outline Stroke, `vectorPathWorldBezier` and SVG export all read it; the anchors, handles and outlines the direct tool shows are the stored ones. A path that draws as several shapes (a repeater) renders as a group of paths with ids `<id>~fx<n>`. `vectorAppearanceShapes(node)` gives the shapes with their source style and opacity, `vectorAppearanceOutline(node)` all of them as one path. The Shape Builder works on the stored geometry.

**Expand Appearance** (`expandAppearance`) stores the expanded form: a node keeps its id (a path drawing several shapes becomes a group of them; a live group drawing one shape becomes that path), the shapes it made get fresh ids, and the result has no effects. Scaling or flipping a node carries `position`, `anchor` and `center` with it (rotation and twist angles turn the other way when it mirrors); sizes and radii stay, like stroke widths.

The operators are exported for direct use on Bézier paths: `trimPaths`, `trimPathsIndividually`, `roundCornerPaths`, `puckerBloatPaths`, `twistPaths`, `zigzagPaths`, `wigglePaths`, `offsetPaths`, `mergePaths`, `vectorRepeaterCopies` / `repeatPaths`, and `applyVectorEffects(shapes, effects)` runs a stack.

### Contour

A `contour` path effect works like CorelDRAW's Contour.

- **Steps.** Each shape gets `steps` concentric copies, `offset` apart (`offsetPaths`, with `join`). They go `inside`, `outside`, or to the `center` (inward until the shape is used up).
- **Colour.** Each step's fill and stroke blend from the shape's own solid colours to `fillColor` / `strokeColor`; null keeps the colour. `acceleration` (−100…100) holds the change back toward the end (positive) or rushes it (negative).
- **Draw order.** Inside steps draw over the shape and outside steps under it.
- **Interaction with other effects.** Like the other effects, it acts on what is above it in the stack, and the effects after it act on its steps.
- **Panels and export.** The effects panels edit end colours with the new `color` parameter kind. Lottie has no equivalent, so it gets the drawn shapes.

### Block shadow

A `blockShadow` path effect works like CorelDRAW's Block Shadow.

- **Shape.** Each shape is swept `distance` along `angle` (degrees, 0 right, 90 down, in the node's own space) by `sweepPath`: the shape, its moved copy and the band each edge sweeps, united. The result is one solid shape drawn under all the shapes.
- **Colour.** `color` fills it (null: the shape's own solid fill) at `opacity` percent. An `endOpacity` different from `opacity` fades it along the direction, from the near side of the shape to the far end, for a flat-design long shadow.
- **Export.** SVG and PDF draw it as a path, with a linear gradient when it fades. PDF shadings have no stop opacity, so a fading shadow is drawn opaque there, with a note. Lottie has no equivalent, so it gets the drawn shapes.

### Extrude

An `extrude` path effect works like CorelDRAW's Extrude and draws each shape as a solid.

- **Depth.** In `parallel` mode the back is the shape moved `depth` along `angle` (degrees, 0 right, 90 down). In `perspective` mode every point is pulled `toward` percent of the way to `vanishingPoint`, an offset from the shape's middle.
- **Faces.** Each edge (curves flattened) gets a side face between it and its copy at the back. `vectorExtrudeFaces(path, params)` returns them.
- **Shading.** The faces are filled with `color` (null: the shape's own solid fill). Each is lightened or darkened by up to `shading` percent by the cosine between its normal and a light coming from `lightAngle` degrees (`shadeVectorColor`).
- **Draw order.** Faces are drawn back to front: two faces overlap only over viewing rays that cross both edges, and there the edge further along the ray is in front. A topological sort of that relation keeps concave outlines correct. The shape itself is drawn on top.
- **Export.** Each face also gets a hairline stroke in its own colour, which hides anti-aliasing seams between neighbouring faces. Lottie gets the drawn shapes.

## Distort and envelopes

**Free Distort.** With `setFreeDistort(true)` (the toolbar's Distort toggle) the selection box distorts instead of scaling, Illustrator's Free Transform way:

| Drag | Does |
| --- | --- |
| A corner | Moves that corner alone: the selection is mapped by the projective map (homography) that takes the box's four corners to the new quad, so straight lines stay straight |
| A corner with Shift+Alt+Mod | Symmetric perspective: the corner moves along the drag's main axis and the corner beside it on that side moves the other way |
| A side | Moves its two corners together |
| A side with Mod | Skews along that side, about the opposite side (Alt: about the centre) |

A quad that would fold over (send part of the box through infinity) keeps the last good shape. The rotate handle still rotates, and each drag is one undo step (`Distort`, `Perspective`, `Skew`). From code: `distort(corners)` (the box's new corners clockwise from the top left, in document space; one undo step) and `skew(ax, ay, { origin })` (degrees along the box's own axes: x' = x + tan(ax)·y). Both work on rotated selections: the map is applied in document space and written back into each node's own space, so a node keeps its rigid `transform`.

Curves go through the map adaptively (`mapVectorSubpaths(subpaths, f, tolerance)`): each segment is halved until its mapped control points follow the mapped curve within the tolerance (0.05 by default), then runs of pieces are refitted with fewer cubics where that stays within it. A straight segment whose image is straight stays one segment; anchors keep their types and live corners, and the anchors added are smooth. `mapVectorPoints` maps anchors and handles only, `mapBezierPath` does the same for Bézier commands, and `vectorHomography(from, to)` / `applyVectorHomography` / `orderVectorQuad` are the projective maths. Gradients in the node's own space (`units: "userSpaceOnUse"`) have their handles mapped point by point; bounding-box gradients (the default) keep filling the shape's new bounding box. Stroke widths, corner radii and effect parameters are kept.

**Envelopes** stay editable: an envelope is an effect (`type: "envelope"`) at the bottom of the stack, so the contents (a path or a group) keep their anchors, the effect panel can turn it off, and Expand Appearance bakes it.

```ts
controller.envelope({ style: "arc", bend: 40, horizontal: 0, vertical: 10 }); // Make with Warp (or change the warp)
controller.envelope({ style: "mesh", rows: 3, columns: 4 });                   // Make with Mesh (a preset becomes its mesh)
controller.makeEnvelopeWithTopObject({ rows: 4, columns: 4 });                 // the top selected closed path is the envelope
controller.releaseEnvelope();                                                  // drop it; its outline comes back as a path
controller.expandAppearance();                                                 // bake it into plain paths
```

- **Warp presets** (`VECTOR_WARP_STYLES`): `arc`, `arcLower`, `arcUpper`, `arch`, `bulge`, `shellLower`, `shellUpper`, `flag`, `wave`, `fish`, `rise`, `fisheye`, `inflate`, `squeeze`, `twist` — Photoshop's fifteen, each a single bicubic patch whose 4 × 4 control grid follows `bend` (−100…100 %); `horizontal` / `vertical` distortion scale its columns and rows (perspective-like), and `orientation: "vertical"` bends along the other axis. The arc family stays circular in the box's own pixels. `vectorWarpPresetGrid` / `vectorWarpPresetMesh` give the grid.
- **Meshes** (`style: "mesh"`, `mesh: VectorWarpMesh`): `rows × columns` bicubic patches; `points` is the control grid row by row in the node's own space (anchors where both indices are multiples of 3, handles where one is), `us` / `vs` the patch boundaries as fractions of the box. A `null` mesh is flat. Changing rows or columns splits the surface exactly when it can (`resizeVectorMesh`, de Casteljau), so a preset turns into a mesh of any size without changing shape. Helpers: `vectorIdentityMesh`, `fitVectorMesh`, `evalVectorMesh`, `splitVectorMeshU` / `V`, `removeVectorMeshSplitU` / `V`, `dragVectorMeshPoint`, `pullVectorMesh`, `vectorMeshParamAt`, `vectorMeshFromOutline` (a Coons patch whose border follows a closed outline, cut at the points nearest its bounding box's corners), `vectorMeshOutline`.
- The **box** is the combined bounds of the paths entering the envelope, taken afresh each time: editing the contents (moving a point, adding a shape to the group) re-lays them over the same envelope. Moving or scaling the node moves a mesh with it (a preset follows the box by itself); a skew, a mirror or a Free Distort turns a preset into the mesh it stood for, then maps that.
- The mapping uses `mapVectorSubpaths` with a tolerance of 1/2000 of the box's diagonal (0.01–0.25 units).

The **Envelope tool** (U) edits the mesh on the canvas (see the tool table); `getVectorOverlayRenderData(state).envelope` has the grid lines, anchors and handles in screen space and `getVectorEnvelopeTarget(document, selection)` the node it edits. `getVectorEnvelopePanel(state)` and `VECTOR_ENVELOPE_STYLE_OPTIONS` drive the Envelope panels.

## Live booleans

`booleanOp(op, { live: true })` keeps the shapes editable: two or more nodes with one parent are wrapped in a **live boolean group** (`liveBoolean: op`); its children are the operands, folded bottom to top, each combined with the result below it by its own `booleanOperation` or the group's. The group draws (and is hit, bounded, snapped to and exported) as the result in the bottom operand's style. With a lone live boolean group selected, `booleanOp(op, { live: true })` sets the group's operation and clears the operands' own; with operands selected it sets theirs. Without `live` the operation is the destructive one, as before: one new path.

Editing any operand (moving it, dragging its points) redraws the result: every prefix of the fold is cached under a rolling hash of the operands it covers (`foldVectorBooleanOperands`), so only the operands from the edited one up are recombined (`vectorLiveBooleanSteps()` counts the boolean steps computed). Clicks hit the result — a click in a subtracted hole goes through — except while the group, or a node in it, is selected or edited: then its operands are hit and outlined, so each can be picked and edited with the direct tool (`vectorEnteredGroups`, `hitTestVectorNodes(…, { entered })`). Groups with effects behave the same way. Ungrouping a live boolean drops the operands' operations; Expand Appearance flattens it into one path.

## Gradients

A fill or stroke can be a gradient (`VectorGradient`; the canvas package's `{ type: "linear", angle }` / `{ type: "radial", cx, cy, r }` are valid ones):

```ts
editor.setGradient({
  type: "radial", // linear | radial | conic | reflected | diamond
  stops: [{ offset: 0, color: "#fde68a", midpoint: 0.3 }, { offset: 1, color: "#7c3aed", opacity: 0.8 }],
  interpolation: "oklab", // srgb (default) | linear | oklab
  smoothness: 0.5,        // 0–1: a spline through the stops instead of straight lines
  spread: "reflect",      // pad (default) | reflect | repeat
});
editor.setGradient({ start: { x: 20, y: 40 }, end: { x: 160, y: 40 }, units: "userSpaceOnUse" }, { target: "stroke" });
```

- **Stops** have an `offset`, `color`, optional `opacity` and a `midpoint` (0.05–0.95, default 0.5): where between this stop and the next the colours are half-mixed. `sampleVectorGradient(g, t)` / `vectorGradientRamp(g)` give the colour at any `t`; `reverseVectorGradient` flips the stops and mirrors the midpoints.
- **Geometry** is a frame of three points, as figcraft's handles: `start` (a radial, conic or diamond gradient's centre), `end` (the main axis: a linear gradient's end, the others' radius) and `width` (the secondary axis' end: the aspect ratio and, for conic, the sweep direction; default square to the main axis and as long), plus a radial `focal` point and `focalRadius` (SVG `fx` / `fy` / `fr`). Points are in `units`: fractions of the shape's box (`objectBoundingBox`, the default) or the node's own coordinates (`userSpaceOnUse`). Without `start` / `end` the shorthand applies: `angle` (CSS degrees: a linear or reflected gradient's direction across the box, default 180; a conic gradient's start angle and a diamond's turn, default 90) and `cx`, `cy`, `r`. `pinVectorGradient(g, box)` turns any gradient into explicit node-space points painting the same; the Gradient tool pins the gradient it edits. Node-space gradients follow scale, skew and flips of their shape exactly (`transformVectorNode` maps their points); box gradients follow the box. A box with no height or width (a straight line) uses the other side, so the gradient still paints.
- **Styles**: t is `u` (linear), `|u|` (reflected: mirrored about the start), the distance through the focal circle (radial), the turn from the main axis towards the secondary one (conic: clockwise on screen) or `|u| + |v|` (diamond: a rhombus through the end and width points), where `u, v` are coordinates in the frame. `vectorGradientTAt` / `sampleVectorGradientAt` evaluate a gradient at a point.
- **On strokes** `strokeMode` says how the gradient lies: `within` (over the stroke's area, like a fill), `along` (t runs 0 → 1 along each subpath by length) or `across` (from the stroke's left edge to its right, looking along the path; an inside or outside stroke's visible band; a width profile's sides).

**Rendering and SVG.** `vectorPaintToSvg(paint, id, { node, role })` returns the paint servers both canvases and `vectorDocumentToSvg` use, all in the painted element's user space. Linear and radial gradients are `<linearGradient>` / `<radialGradient>` with `gradientUnits="userSpaceOnUse"` and a `gradientTransform` (the box, or the frame), `spreadMethod` and `fx` / `fy` / `fr`. Midpoints, smoothness and linear-light / Oklab interpolation are not native to SVG: they export as extra stops (`expandVectorGradientStops`), one per off-centre midpoint (exact) or placed until straight sRGB interpolation between them is within half a colour level. A reflected gradient is a linear gradient with mirrored stops over `[2·start − end, end]` (`spreadMethod="reflect"` when its spread is reflect; repeated stop periods over the painted area when it repeats, `expandVectorGradientSpread`). SVG has no conic or diamond gradient, so they are a `<pattern patternUnits="userSpaceOnUse">` over the shape: a diamond is four triangles, each with an exact linear gradient (t = ±u ± v), and a conic gradient is 72 wedges, each with a linear gradient along the tangent at its middle angle (exact on the frame's unit circle; elsewhere a point takes a colour from within its 5° wedge; stops inside a wedge stay sharp). Gradients along or across a stroke are a pattern of slices, one per flattened segment of the path, each with its piece of the gradient (`vectorStrokeGradientDefs`); the stroke only paints through it where it draws, so caps, joins, dashes and arrowheads need nothing more. Tiles overlap slightly to hide anti-aliasing seams. Patterns work as `fill` and `stroke` in both canvases and in any SVG reader; `sampleVectorPaintDefAt` evaluates a paint server the way a renderer would. `VectorGradientDefs` (React, Svelte) render `scene.defs`: gradients, and patterns as their gradients followed by their tiles.

Export puts the gradient itself on its first paint server as `data-vector-gradient` (JSON), so every field round-trips; import of other SVG reads `gradientUnits`, `gradientTransform` (mapping the three points), `spreadMethod`, `fx`, `fy`, `fr` and `href` inheritance; box gradients without a transform keep the angle / centre shorthand when it paints the same, and `userSpaceOnUse` gradients are carried through the element's transform with the shape.

**Editing.** `setGradient(patch, { ids, target, merge })` edits the selected paths' fill (or `target: "stroke"`; default: `state.gradientEdit.target`, set with `setGradientTarget`) — any gradient field, `aspect`, `reverse: true`, `focal: null` — and a colour becomes a gradient from it to white; `setGradientStop(index, { color, opacity, offset, midpoint })`, `addGradientStop(offset)`, `removeGradientStop(index)` (never below two), `selectGradientStop(index)` and `reverseGradient()` work on the stops by sorted index. `getVectorGradientEditor(state)` gives a gradient editor what to show (stops, the selected stop, a CSS preview of the ramp, spread, interpolation, smoothness and stroke mode); `getVectorOverlayRenderData(state).gradient` is the Gradient tool's annotator in screen pixels (`getGradientAnnotator()` on the controller for hit-testing: `hitVectorGradientAnnotator`). Blends mix two gradients of one style stop by stop (midpoints too) when they match, else resample both at every offset where either bends; points mix when both are explicit in the same units.

### Gradient meshes and freeform gradients

```ts
controller.setMeshGradient({ rows: 2, columns: 2, corners: ["#bae6fd", "#38bdf8", "#e0f2fe", "#ffffff"] }, { ids: ["card"] });
controller.setMeshPoint("card", 4, { x: 200, y: 120, color: "#fef9c3" }); // the middle point, row by row
controller.setFreeformGradient({ colors: ["#15803d", "#4ade80"] }, { ids: ["hill"] }); // points placed inside
controller.addFreeformPoint("hill", { x: 300, y: 420, color: "#166534", spread: 0.2 });
```

Both are paint objects in the node's own space, like its anchors, and move with the node.

- **Mesh: `{ type: "mesh", rows, columns, points, colors, opacities? }`.**
  - It is a lattice of `(rows + 1) × (columns + 1)` points.
  - Each patch is a Coons surface whose sides are Catmull-Rom curves through the lattice, extended past the edges in straight lines, so moving a point bends its neighbouring patches smoothly.
  - Colours blend bilinearly between each patch's corners.
- **Freeform: `{ type: "freeform", points: [{ x, y, color, opacity?, spread? }], lines? }`, after vectorcraft.**
  - Each point paints a disc of pure colour; `spread` is a fraction of half the box's longer side.
  - Beyond the discs, points blend by inverse-square distance from each disc's edge.
  - Lines are Catmull-Rom curves through points that carry colour along their length.
  - `autoVectorFreeformGradient` places a 2 × n grid of points inside the shape.
- **Drawing.** SVG has no shading for either, so `vectorShadedSvgDefs` returns a `<pattern>`, and both canvases draw it as they draw conic gradients.
  - Mesh cells (8 per patch side) are flat tiles grown slightly so no seams show.
  - Freeform is horizontal strips (96 across the longer side), each a linear gradient sampled across the field.
  - Export writes the paint as `data-vector-shading`, so import restores it.
- **Editing.**
  - With the Gradient tool, `overlay.shading` shows the lattice or lines and the points of the selected paths.
  - Drag a point to move it. Click inside a freeform shape to add a point in the colour shown there, and Alt-click a freeform point to remove it.
  - The picked point is `state.shadingPoint`, which `VectorShadingPanel` recolours.

## Image Trace

```ts
controller.traceImage(pixels, { mode: "threshold", threshold: 0.5, tolerance: 1, cornerRoundness: 0.5, x: 0, y: 0, width: 200 });
controller.traceImage(pixels, { mode: "color", colors: 6 }); // a stacked path per colour
traceVectorImage({ width, height, data }, options); // the paths alone, in pixel units
```

After effectcraft's `trace.rs`. The steps:

- **Contours.** Marching squares runs over the samples at pixel centres. Each crossing is interpolated along its cell edge, a saddle cell is resolved by the cell's mean, and the field is padded with "outside" so every contour closes.
- **Simplification.** Each loop is simplified with Douglas–Peucker to `tolerance` (pixels), and loops smaller than `minArea` are dropped.
- **Nesting.** Each loop gets its nesting depth. Holes come out as even-odd subpaths of one compound path, outer loops first.
- **Fitting.** Loops are fitted with our `fitCubics`. `cornerRoundness` 0 keeps the simplified polygon. Higher values let larger turns stay smooth: the corner angle is 25° + 125° × roundness.

The two modes:

- **Threshold** traces where darkness over white reaches `threshold`, or where alpha does with `channel: "alpha"`.
- **Colour** quantises the opaque pixels by median cut. A split falls where the channel value changes, so identical colours stay in one box. The colours are traced from the most common up, and each colour's path also covers the colours traced after it, so the stacked shapes leave no gaps between them.

`traceImage` places the result as one group (one undo step). Agents pass a PNG data URL to `vector.traceImage`, which core decodes with its own PNG reader, up to 4 million pixels. The panels decode any image the browser can read, scaled to at most 1 million pixels.

## Lottie

```ts
const { lottie, notes } = controller.toLottie({ fps: 30, frames: 60 });   // or vectorDocumentToLottie(doc)
controller.importLottie(json, { frame: 12 });                              // or parseVectorLottie(json, { frame })
```

This follows effectcraft's `lottie/shapes.rs` and `anim.rs`.

**Export** writes one shape layer with a group per node, top first. Each group's `tr` carries the node's rotation, position and opacity.

- **Paths** are `sh` items in the node's own space, followed by their effects, then strokes and fills (top layer first), and repeaters after the paint so they copy it.
- **Effects** map one to one onto Lottie modifiers: trim `tm`, round corners `rd`, pucker & bloat `pb`, twist `tw` (centre made absolute), zig zag `zz`, offset `op`, merge `mm`, repeater `rp` (anchor made absolute).
- **Gradients** become `gf` / `gs` with absolute start and end points and expanded stops. Conic and diamond gradients are written as radial, and reflected as linear.
- **Live booleans** become Merge Paths in the bottom operand's style.
- **Drawn shapes.** Clip masks and frames export their clipped shapes. Text, instances and wiggle or envelope effects export as drawn. Aligned, arrowed or profiled strokes export as filled outlines.
- **Left out:** filters, mesh and freeform gradients (written as their first colour) and opacity masks. `notes` lists each of them.

**Import** reads one frame (`lottieValueAt` eases keyframes with their bezier handles and honours held keys).

- **Layers:** shape layers, solids, nulls (for parenting) and precomps, read recursively.
- **Paints and modifiers** act on every shape above them in their group, so the shapes between two paint items become one compound path with those paints and modifiers. The modifiers become live effects.
- **Transforms:** group and layer transforms are baked through `transformVectorNode`. Additive layer masks clip the layer.
- **Left out, with notes:** images, text layers, mattes, layer effects, expressions and skew.

## PDF

```ts
const { bytes, pages, notes } = controller.toPdf({ pages: "artboards", scale: 1, title: "Poster" });
```

`vectorDocumentToPdf` writes a vector PDF with a writer of its own, after cadcraft's `io/pdf.rs` and pdfcraft's content operators. It draws the scene render data (`getVectorSceneRenderData` with an identity viewport), so the PDF shows what the canvas shows: effects expanded, text as glyph outlines, paint stacks, clip masks and frames. The page is flipped to y down at `scale` points per unit.

- **Paths** become `m` / `l` / `c` / `h` and are filled (`f`, `f*`) or stroked (`S`) with width, caps, joins and dashes.
- **Opacity and blend modes** become ExtGStates (`ca`, `CA`, `BM`). A group's opacity and blend mode are applied to each object in it.
- **Clip masks** become clipping paths. Inside strokes clip to the shape; outside strokes clip to the box minus the shape (even-odd).
- **Linear and radial gradients** become PDF axial and radial shadings with stitched functions, clipped to the shape, with object-box units and `gradientTransform` applied by `cm`.
- **Pattern paints** (conic, diamond, mesh, freeform) draw as their tiles.
- **Left out, named in `notes`:** filters, opacity masks, stop opacity, repeat and reflect spreads, and text without glyph outlines.

`pages: "artboards"` writes one page per top-level frame at the frame's size (see `vectorFrameDocument`). The demo's Export PDF button downloads the file. Agents get it as a base64 data URL from `vector.exportPdf`.

## Text

```ts
import { createOutlineTextShaper, loadOpenTypeFont } from "@pixerate/editor/vector";

const id = controller.addText({ text: "Hello", x: 40, y: 80, font: { fontFamily: "Inter", fontWeight: 700, fontSize: 32 } });
controller.setTextStyle(id, { fill: "#16a34a" }, { start: 0, end: 1 });      // a run: the "H" in green
controller.addText({ text: "Wraps in its box", x: 40, y: 120, width: 200, height: 80, paragraph: { align: "justify" } });
const arc = controller.addPath("M40 300 C140 220 300 220 400 300");
controller.typeOnPath(arc, { text: "Along the arc", paragraph: { align: "center" } });

// Glyph outlines: Create Outlines, and path effects / envelopes acting on the letters.
controller.setTextShaper(createOutlineTextShaper([await loadOpenTypeFont(fontFile)]));
controller.createOutlines({ ids: [id] });
```

- **Model.** `VectorTextNode` has `text`, a base `font` (`VectorCharacterStyle`: family, weight, italic, size, tracking in 1/1000 em, leading, baseline shift, underline, strike-through), optional `runs` (`{ length, style }` in UTF-16 code units; a style overrides fields of `font` and may carry its own `fill`), an optional `paragraph` (align, auto leading, indents, spacing) and a `frame`: `point` (`x`, `y` of the first baseline), `area` (a box at `x`, `y`; lines past its height are hidden and reported as overflow) or `path` (a subpath in the node's space with `start` / `end` margins, `flip`, `orientation` rotate / upright and `baseline` baseline / ascender / descender / center). It extends `VectorStyle`, so fills, strokes, stacks, filters, blend modes, opacity, masks and blends work as on paths. Scale bakes into the font size (by √|det|) and an area's box per axis; the transform stays rigid.
- **Layout is shared with the image editor.** `src/text` holds the type-layer layout (`layoutText`: paragraphs, line breaking, justification, tracking, leading, indents, caret positions) and the `TextShaper` interface the image editor introduced. `layoutVectorText` turns it into glyphs placed in the node's space; path text lays the line out once and places each character by the middle of its advance along the measured path (`measureVectorPath`, `vectorPathTextPositions`).
- **Fonts come from one shaper per page** (`setVectorTextShaper`, or the controller's `textShaper` option / `setTextShaper`). The default in a browser is the Canvas 2D shaper (`createCanvasTextShaper`): the browser's fonts, measured, with text drawn as SVG `<text>` whose characters are placed by our layout. Outside a browser it is `createMetricTextShaper`, which estimates advances so layout still works. `createOutlineTextShaper` over fonts read by `parseOpenTypeFont` / `loadOpenTypeFont` (TrueType `glyf`, CFF and CID-keyed CFF, collections, WOFF 1; `cmap` 4 and 12; `kern` and GPOS pair kerning; no GSUB, so ligatures and complex scripts are not shaped) gives glyph outlines: text then draws as paths, so path effects, envelopes, booleans, the Shape Builder and Create Outlines act on the letters.
- **Editing.** The Type tool (T) adds point text on a click and area text on a drag; Type on a Path (Q) turns the clicked path into path text; double-clicking text (any of the select and type tools) edits it. `editText`, `selectText`, `textInput`, `endTextEdit` and `keyDown` (arrows, Alt for words, Home / End, Backspace / Delete, Enter, Escape, Mod+A / B / I / U) drive the session; `state.textEdit` holds the node and the selection, and `getVectorOverlayRenderData(state).text` the caret, selection quads, frame and overflow marker in screen space. A session is one undo step; new text left empty disappears without one.
- **Styles.** `setText`, `setTextStyle` (a range, or the whole text which changes `font` and the node's `fill`), `setParagraphStyle`, `styleTexts` (several nodes, one step) and `setTextFrame` (point ↔ area ↔ path, box size, path options). `getVectorTextPanel` / `applyVectorTextStyle` / `applyVectorParagraphStyle` back the text panels: they edit the selected characters while editing, else the selected text, else `textDefaults` for new text.
- **SVG.** Text exports as `<g data-vector-text>` holding a `<text>` per paint layer with a `<tspan>` per styled fragment and per-character `x` / `y` / `rotate`, plus the text's JSON for a lossless re-import. With outlines and path effects (or `text: "outlines"`), it exports as its outlines with the text kept in a hidden source group. Import also reads foreign `<text>` as point text (content, font, `text-anchor`, fill).

## Symbols and instances

```ts
const { symbolId, instanceId } = controller.makeSymbol({ ids: ["leaf", "stem"], name: "Plant" });
controller.placeSymbol(symbolId, { transform: [1.5, 0, 0.2, 1.5, 300, 200] }); // scaled and skewed
controller.setInstanceOptions({ fill: "#65a30d", hidden: ["stem"] }, { ids: [instanceId] });
controller.editSymbol(instanceId); // isolation: the document is now the symbol's art
controller.addShape({ kind: "ellipse", x: -4, y: -30, width: 8, height: 8 });
controller.exitSymbolEdit(); // every instance has the new shape
```

- **Model.** `VectorDocument.symbols` holds `{ id, name, nodes }`, the art in the symbol's own space around its registration point (0, 0). An `instance` node has `symbolId`, a `transform` that may scale and skew (the one exception to rigid transforms), `scaleStrokes` (default true: strokes and other paint lengths scale by √|det|, as in Illustrator) and `overrides` (`fill` / `stroke` paint every fill or stroke of the art, `hidden` art node ids).
- **Resolved art.** Geometry, rendering and export see one node at a time, so each instance carries its symbol's art (`art`, the symbol's own `nodes` array) and draws it as a group (`vectorInstanceGroup`): its rotation stays on the group (rigid), scale and skew are baked into the art, and ids are `<instance>~<art>`. The controller resolves after every change (`resolveVectorSymbols`, as blend steps are refreshed); `toJSON` and SVG export leave `art` out (`stripVectorSymbolArt`), and loading resolves it again. A missing symbol, or one that would contain itself, draws nothing.
- **Editing.** Make Symbol (F8) turns objects sharing a parent into a symbol with its registration point at their centre and an instance in their place. Detach (Break Link) turns an instance into a plain group of its art as drawn. Edit Symbol (double-click an instance, or `editSymbol(id)`) is isolation mode: `state.document` becomes the symbol's art, every command edits it, and `state.symbolEdit.host` is the whole document, which the canvases draw dimmed behind it through `hostTransform` (the instance's origin and scale; the view moves so the art shows where the instance was). Escape with nothing selected, or Done, leaves. Snapshots keep the isolation state, so undo steps back into the symbol with the edits made there; `toJSON`, `toSvg` and `onChange` always give the whole document.
- **SVG.** Symbols export as `<symbol>` in `defs` (unused ones too) and instances as `<use>` when that draws them exactly; instances with overrides, unscaled strokes, effects or filters export as their drawn art in a `<g data-vector-instance>`. Import restores both, and reads foreign `<use>` as instances of a symbol made from what they refer to (a `<symbol>`'s children or the element itself).

## Constraints

```ts
const h = controller.addConstraint({ kind: "horizontal", refs: [{ nodeId: "frame", subpath: 0, index: 0, segment: true }] });
controller.setConstraintValue("w", 120); // a named parameter
controller.addConstraint({ kind: "distance", refs: [{ nodeId: "frame", subpath: 0, index: 0, segment: true }], value: "w", name: "width" });
controller.addConstraint({ kind: "tangent", refs: [{ nodeId: "frame", subpath: 0, index: 1, segment: true }, { nodeId: "wheel", circle: true }] });
controller.autoConstrain({ ids: ["frame"] });
controller.getConstraintDof(); // { dof, status: "under" | "fully" | "over", redundant, nodes, message }
```

- **Model.** `VectorDocument.constraints` holds `{ id, kind, refs, value?, name?, axis? }` and `parameters` named expressions. A reference is an anchor of a path by its stable `id` (`VectorAnchor.id`, given when a constraint first refers to it; `addConstraint` takes `subpath` / `index` and assigns it), one of its handles, the segment from it to the next anchor (`segment`: the straight line between their points), or a round closed path as a circle (`circle`: its centre and radius). Kinds and the references they take are listed on `VectorConstraintKind` and in the agent skill. Dimensional values are expressions over parameters and other dimensions' names (`+ - * /`, parentheses, `pi`).
- **Solving.** The referenced points, handles and circles become a parameter vector in document space; each constraint becomes residual rows (in length units, angles scaled by their segments' size), and a damped, weighted, minimum-norm Gauss–Newton solve (ported from cadcraft) runs per connected component. The controller solves after every change (`refreshed`, so during drags too), weighting what changed since the last solve a million times heavier, so the anchor being dragged stays under the pointer and the rest follows. A circle scales and moves its path's anchors and handles about the centre; an anchor that moves carries its handles unless they are constrained themselves. Constraints on deleted anchors or paths are dropped. A component that cannot be solved keeps its best compromise and is reported in `state.constraintIssues`.
- **Adding.** `addConstraint` measures a dimension without a value, names it (`d1`, `ang1`, `rad1`, `dia1`), and refuses — changing nothing — a constraint that conflicts with the others (naming each whose removal would let it hold) or adds no independent equation (over-constrains, naming the constraints it repeats), as AutoCAD does. `setConstraintValue` sets a dimension or parameter and refuses values the constraints cannot meet.
- **Degrees of freedom.** `vectorConstraintDof` gives the free parameters minus the Jacobian's rank per component (Householder QR with column pivoting on a balanced matrix), the redundant equations, and per path the rank of the null space restricted to its parameters.
- **Auto Constrain.** `inferVectorConstraints` lists what a sketch nearly satisfies (coincident points of different paths, concentric / tangent circles, a segment tangent to a circle, horizontal / vertical segments, collinear, connected perpendicular and parallel segments, equal lengths and radii); `autoConstrain` adds them one by one, skipping refused ones.
- **UI.** `getVectorOverlayRenderData(state).constraints` places a glyph (or `name = value`) and a dimension line per constraint of the selected paths; `getVectorConstraintPanel` gives the DOF message, the constraints the selected anchors (direct tool) or round paths allow, the selection's constraints and the parameters.

## Live symmetry

```ts
const { id } = controller.makeSymmetry({ mode: "radial", copies: 8, mirror: true, center: { x: 200, y: 150 } }, { ids: [] }) as { ok: true; id: string };
controller.addShape({ kind: "ellipse", x: 205, y: 100, width: 10, height: 30 }, { parentId: id }); // repeated 16×
controller.enterSymmetry(id); // new pen, pencil, shape and text art goes in, mirrored as it is drawn
controller.releaseSymmetry({ ids: [id], expand: true }); // the copies become real objects
```

- **Model.** A group with `symmetry: { mode, center, rotation?, copies?, mirror? }` draws its children and their copies.
- **Modes.** The mirror modes follow photocraft's `symmetry.rs`:
  - `vertical`: mirror across a vertical axis;
  - `horizontal`: mirror across a horizontal axis;
  - `diagonal`: mirror across the diagonal;
  - `dual`: both mirrors plus a half turn;
  - all turned by `rotation`.
- **Radial** gives `copies` turns. With `mirror` it also adds the `copies` reflections, the dihedral group (like a kaleidoscope).
- **Copies are appearance.** `vectorSymmetryDrawn` adds locked copies (ids `<id>~sym<k>`) through the appearance pipeline. They draw, hit-test, bound, snap and export (SVG keeps `symmetry` in the live group's data, so it round-trips; Lottie and PDF draw them) but are never stored or edited.
- **Transforms.** A transform baked into the group moves its centre and turns or flips its axes (`transformVectorSymmetry`).
- **Drawing inside.** `enterSymmetry` (the panel's Draw inside) sends new pen, pencil, shape and text nodes into a top-level, unturned symmetry group until Escape or `exitSymmetry`.
  - A new empty group starts entered.
  - `overlay.symmetry` gives the axes to draw: dashed, solid while drawing inside.
  - Agents add art with `parentId` on `vector.addShape` / `vector.addPath`.

## Frames and artboards

```ts
const { id } = controller.addFrame({ x: 0, y: 0, width: 375, height: 812, name: "Phone", adopt: true }) as { ok: true; id: string };
controller.frameSelection({ ids: ["bar", "badge"], padding: 16, fill: "#0f172a" });
controller.setResizing({ horizontal: "leftRight", vertical: "bottom" }, { ids: ["bar"] });
controller.setFrame({ width: 414 }, { ids: [id] }); // children follow their constraints
controller.frameToSvg(id); // the artboard alone, its corner at the origin
```

- **Model.** A frame is a group with `frame: { x, y, width, height, fill?, clip? }`, a rectangle in the group's own space. Top-level frames are artboards. Blends, live booleans and mask groups ignore `frame`. Each node may carry `resizing: { horizontal?, vertical? }`, used when its parent is a frame.
- **Drawing.** `vectorFrameDrawn` turns a frame into an equivalent clip group: the rectangle as the mask (`<id>~frame-clip`), then the fill (`<id>~frame-fill`) and the children. Without the clip it becomes a plain group of the fill and the children. Rendering, appearance shapes, mask regions and snapping go through it, so both canvases draw frames with no code of their own.
- **Selection.** Bounds are the rectangle (plus the children when `clip: false`). A frame is hit anywhere in its rectangle, filled or not. Clicking it selects the frame; double-click enters it like a group. The overlay's `frames` lists each artboard's name label in screen space, and clicking a label selects that frame.
- **Resizing.** `transformVectorNode` on a frame maps its rectangle. With an axis-aligned scale and translation, each child then takes the matrix `vectorFrameChildMatrix` gives for its constraints: the child keeps its left or right margin, keeps both (stretch), keeps its offset from the centre, or scales. These are figcraft's `apply_constraints`, as the canvas package's auto layout has them. Area text takes the new box at the same font size, and point and path text move with their box's centre. A skew, rotation or mirror scales every child instead. This applies to the selection handles, `scale` and `setFrame`, which maps the rectangle in the frame's own space so a rotated frame keeps its rotation.
- **Frame tool (F).** Drags out a rectangle, previewed as a white rectangle. On release it becomes a frame holding the top-level objects it fully encloses. `frameSelection` wraps objects that share a parent in a frame fitted to their bounds, placed where they sit in the stacking order.
- **SVG.** A frame exports as a `<g data-vector-frame>` with the frame as JSON, a `frame-fill` part and a `frame-contents` part clipped by a `<clipPath>` rectangle. Import rebuilds the frame, keeping its rotation as the group's transform. `data-vector-resizing` carries constraints. `vectorFrameDocument` / `frameToSvg` export one frame as a document of its own size.
- **UI.** `getVectorFramePanel(state)` gives the selected frame and the resizing constraints of the selected children of frames (`mixed` when they differ). Both panels apply typed sizes on Enter or blur.

## Connectors

```ts
const { id } = controller.addConnector({ start: { nodeId: "a" }, end: { nodeId: "b", side: "top" }, route: "elbow", radius: 6 }) as { ok: true; id: string };
controller.setConnector({ end: null }, { ids: [id] }); // unglue: the end stays where it is
controller.getConnectors(); // ends with the glued object, the side in use and the position
```

- **Model.** A connector is an open path with `connector: { start?, end?, route?, radius?, gap? }`. Each end is `{ nodeId, side? }` or absent (free). A side is `top`, `right`, `bottom`, `left`, `center` or `auto` (the default).
- **Sites.** `vectorConnectionSites` gives the middle of each side of the object's own bounds and its centre, mapped through its rotation and its ancestors' transforms, each with an outward normal. `auto` picks the side whose normal faces the other end (its object's centre, or its free point).
- **Routing.** `rerouteVectorConnectors` runs in the controller's `refreshed`, after the constraint solve. It is part of every edit and its undo step, and runs on every frame of a drag. `straight` is one segment. `elbow` leaves and enters along the sides' normals (straight out by `gap`, default 16), then turns at right angles through the middle, with `radius` as live corners on the bends. `curved` puts the handles along the normals. Glue to an object that is gone or has no extent is dropped, and the end stays put. The routed points are written into the connector's own space, so a connector in a moved group still meets its objects.
- **Connector tool (X).** Pressing near a site (12 px) glues the start to that side; pressing on an object glues it `auto`; anywhere else leaves it free. The end glues the same way on release, and the tool gives the line a triangle arrowhead unless the defaults set one. While the tool is on, `overlay.connectorSites` lists the sites of the object under the pointer and marks the one that would glue.
- **SVG.** `data-vector-connector` carries the settings, and import restores them.

## Large documents

Hit-testing (`hitTestVectorNodes`), marquee selection and snapping to segments go through an R-tree once a node list (or a gesture's segment targets) reaches 256 entries (`VECTOR_SPATIAL_MIN`). The tree is packed sort-tile-recursive over each node's paint box (strokes and filters included) and cached per node array; each node's box is cached per node object, so after an edit only the nodes it replaced are measured again. Queries return candidates in draw order and the same exact tests then run, so results match a scan.

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

### Tracking, polar angles and typed entry

The following adds CAD-style drawing aids from cadcraft's `snap/tracking.rs`.

- **Object snap tracking (`snap.tracking`, on by default).** While the pen or a shape tool hovers, resting on an anchor, centre or crossing for `TRACKING_DWELL_MS` (400 ms) acquires that point. Resting there again releases it. The editor keeps at most `VECTOR_MAX_TRACKING_POINTS` (7) acquired points, dropping the oldest. Each one sends horizontal and vertical paths, or one along every polar angle with `snap.trackPolar`. An open path's acquired end also sends its extension. A point snaps first where two paths cross (`tracking`), then where a path crosses the drawing (`intersect`), and finally onto the nearest path. The pen's polar paths from its last point take part in the crossings too. Escape releases acquired points, and so does switching tools. `acquireTrackingPoint({ x, y })` toggles a point from code.
- **Polar angles.** `snap.angles` holds the polar / construction angles. `vectorPolarAngles(increment, additional)` builds them from an increment (as POLARANG / POLARADDANG). With `snap.polarRelative`, the pen measures them from its last segment. The toolbars have a 90° / 45° / 30° / 15° picker.
- **Typed entry.** While the pen draws, typing digits builds an entry that shows next to the pointer (`state.typedEntry`, `overlay.typedEntry`), and Enter places the next point:
  - `120`: that far toward the pointer;
  - `120<30`: that far at 30°;
  - `@40,-10`: an offset;
  - `200,150`: a position.

  `placePenPoint(text)` does the same from code. `addPathByDimensions({ start, steps, closed })` draws a whole path from lengths and angles, offsets or positions. Agents use `vector.addPathByDimensions`, and set snapping with `vector.getSnapOptions` and `vector.setSnapOptions`.

## Rendering

`getVectorSceneRenderData(state)` returns the document as SVG-ready paths (with gradient defs) and a `transform` for the document layer; `getVectorOverlayRenderData(state)` returns the overlay in screen pixels: outlines, the selection box with its handles, anchors, handles, the marquee, the pen's rubber band, smart guide lines and labels (`guides`), the knife or eraser stroke being drawn (`toolStroke`), the pencil's lazy-mouse string (`pencilString`), the scissors cut point (`cutPoint`), the live corner widgets (`cornerWidgets`), the width tool's `widthPoints` and `widthSpot`, each selected blend's spine and the Blend tool's picks (`blend`), the Gradient tool's annotator (`gradient`: start, end / radius, aspect and focal handles, stop chips with ticks to the bar, midpoint diamonds and the extent outline), the Shape Builder / paint bucket highlight (`builder`: faces to fill translucent, `hatches` to stroke over them (45° lines `VECTOR_BUILDER_HATCH_GAP` pixels apart; empty strings for the paint bucket), line pieces and outline edges an erase deletes, the drag's trail; `mode` `merge`, `erase` or `fill`), and a status string. Draw the overlay outside the transformed layer so handles keep their size at any zoom. Scene nodes carry an SVG `transform` when rotated, and the selection box comes unrotated with a `transform` (`rotate(angle cx cy)`) to draw it in — handle `screen` positions are the true on-screen points. A path whose stroke is aligned or has arrowheads carries `strokeParts`: draw `d` with the fill only, then `strokeParts.d` at `strokeParts.width` with its `clip` (a `<clipPath>` of the shape for inside, a user-space `<mask>` over `clip.bounds` that hides the shape for outside), then each head filled with the stroke; a variable-width stroke has `strokeParts.outline` instead, filled with the stroke paint under the same clip. The canvases group them under the node's id as `<g data-vector-id data-vector-stroke-align>` with `data-vector-part="fill" | "stroke" | "stroke-outline" | "head"` children. The bundled React and Svelte canvases are thin renderers over these two functions.

**Performance.** `getVectorSceneRenderData` caches each node's render data by node object, id prefix and text shaper generation, together with the defs and filters it made. An untouched node comes back as the same object, so `<VectorCanvas>` skips it: React through `React.memo`, Svelte through its keyed blocks. A one-node edit of a 3000-shape drawing rebuilds in about 0.2 ms instead of 12 ms.

The canvases also pass their measured size (`viewportSize`):

- **Culling.** Top-level nodes whose paint box is off screen are left out, found through the spatial index on large documents.
- **Level of detail.** Groups, text and instances smaller than `lod` screen pixels (default 2) draw as one rectangle in their main colour.

`scene.stats` reports the counts. Exports such as SVG, PDF and the symbol thumbnails call it without a size, so they draw everything exactly.

## SVG

```ts
import { parseVectorSvg, vectorDocumentToSvg } from "@pixerate/editor/vector";

const doc = parseVectorSvg(markup);        // DOM-free: path, rect, circle, ellipse, line, polyline, polygon, g,
                                           // linear / radial gradients (fx, fy, fr, spreadMethod, gradientTransform,
                                           // userSpaceOnUse), style attributes and transforms
const svg = vectorDocumentToSvg(doc);      // standalone SVG with <defs> for gradients and patterns
```

Live corners export as their rounded outline plus `data-vector-d` (the sharp path) and `data-vector-corners` (`subpath.index:radius[:kind]`), so the editor's own SVG imports with editable corners. Inside / outside strokes and arrowheads, which SVG cannot express, export as a `<g data-vector-path>` holding the fill, the double-width stroke with a `<clipPath>` or `<mask>`, and the heads as filled paths; a variable-width stroke exports as its filled outline with `data-vector-width-profile` (`vectorDocumentToSvg(doc, { strokes: "outline" })` writes one filled outline of the stroke instead); import merges such a group back into one path with its alignment, heads and real stroke width.

A blend group exports its options and spine as `data-vector-blend` (JSON) and its steps with `data-vector-blend-step`; import keeps the blend live and drops the steps, which are rebuilt from the keys.

A node with path effects or a live boolean exports as `<g data-vector-live>` (the effects and live boolean as JSON) holding what it draws (`data-vector-part="appearance"`) and its editable source, hidden (`data-vector-part="source" display="none"`); operands carry `data-vector-boolean-operation`. Other SVG readers see the drawn appearance; import rebuilds the live node from the source and regenerates the appearance.

On import each shape's transform is split: its rotation becomes the node's `transform` and any scale or skew is baked into the anchors (stroke widths are scaled by the transform's average scale). Export writes rotated nodes with `transform="matrix(…)"`. Text, images, clip paths, masks, filters and `<use>` are skipped. See [Gradients](#gradients) for how gradients export and import.

## React

```tsx
import { VectorEditor, useVectorEditorController, useVectorCommands } from "@pixerate/editor-react/vector";

function Drawing() {
  const controller = useVectorEditorController({ document: doc });
  useVectorCommands(registry, controller); // optional: palette and agent commands
  return <VectorEditor controller={controller} height={520} />;
}
```

`<VectorCanvas>` (smart guides drawn in `guideColor`), `<VectorToolbar>` (with a snapping toggle, `showSnap`, and a path-editing group, `showPathEdit`: Join, Average, Cut at Points, Remove Redundant Points, Smooth, Outline Stroke, the Keep shape / Curvature / Shapes toggles, and the pencil smoothing and eraser size inputs and the paint bucket's Gaps toggle while those tools are active; a Blend group, `showBlend`: Make Blend, spacing, steps or distance, Orient to spine, Replace Spine, Expand and Release; the Combine group is followed by a Pathfinder group with Divide, Trim, Merge, Crop, Outline and Minus Back) and `<VectorStylePanel>` (fill, stroke, a gradient editor for either — also available alone as `<VectorGradientEditor>`: Fill / Stroke, type or Solid, Reverse, the stop ramp (click to add a stop; pick one to edit its colour, opacity, position and midpoint, or delete it), colour space, smoothness, spread and how it lies on a stroke —, width, alignment, width profile, arrowheads, corner radius and kind, opacity, and the Effects section, also available alone as `<VectorEffectsPanel>`: add an effect, and for one selected node turn its effects on and off, reorder, remove and edit them — slider drags and typing are one undo step — plus Expand Appearance) can be used on their own; the toolbar's Combine group has a Live toggle (`data-vector-live-boolean`) that makes the boolean buttons live; the canvas draws corner widgets with the direct tool and the Shape Builder / paint bucket faces (`data-vector-builder-face`, hatched with `data-vector-builder-hatch`, erased pieces as `data-vector-builder-line`) and blend spines (`data-vector-blend-spine`), the Blend tool's first pick (`data-vector-blend-start`) and anchors (`data-vector-blend-anchor`), and the Gradient tool's annotator (`<VectorGradientAnnotator>`: `data-vector-gradient-annotator`, `-bar`, `-handle`, `-stop`, `-midpoint`, `-extent`), a Free Distort drag's quad (`data-vector-distort`) and the Envelope tool's mesh (`data-vector-envelope-mesh`, `-grid`, `-anchor`, `-handle`); the toolbar's Distort group (`showDistort`) has the Free Distort toggle (`data-vector-free-distort`), and the style panel ends with the Envelope section, also available alone as `<VectorEnvelopePanel>`: Make with Warp, Mesh or Top Object, Release and Expand, and for one selected object its warp preset, bend and distortion sliders (a drag is one undo step), orientation and mesh rows × columns; `useVectorEditor` / `useVectorEditorState` give the state.

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

`createVectorEditor(controllerOrOptions)` exposes the state reactively (call `destroy()` when done). `<VectorCanvas>` takes `guideColor` and `<VectorToolbar>` `showSnap`, `showPathEdit`, `showBlend` and `showDistort`, as in React; `<VectorStylePanel>` includes the gradient editor (also exported as `<VectorGradientEditor>`, built from `getVectorGradientEditor(state)` like React's) the Effects section, also exported as `<VectorEffectsPanel>`, and the Envelope section, also exported as `<VectorEnvelopePanel>` (built from `getVectorEnvelopePanel(state)`), the canvas draws the Free Distort quad and the Envelope tool's mesh with the same data attributes, the canvas draws the Gradient tool's annotator (`<VectorGradientAnnotator>`), and the toolbar has the same Live boolean toggle. Both panels build their parameter controls from `getVectorEffectsPanel(state)` and `VECTOR_EFFECT_MENU`. Both toolbars build the path-editing group from `VECTOR_PATH_ACTIONS` and `VECTOR_EDIT_TOGGLES`, and the Pathfinder group from `VECTOR_PATHFINDER_ACTIONS`.

## Agent commands

`createVectorCommands(controller)` returns `vector.list`, `vector.select`, `vector.addShape`, `vector.addPath`, `vector.setStyle` (fill, stroke — colours or gradient objects, sanitized —, width, caps, joins, dashes, fill rule, `strokeAlign`, `startArrow` / `endArrow`, `arrowAlign`, `startArrowScale` / `endArrowScale`, `strokeWidthProfile`), `vector.setGradient` (the fill's or `target: "stroke"`'s gradient: any gradient field, `aspect`, `reverse`), `vector.setWidthProfile` (a `preset`, `points`, or a parametric `taper` / `wave`), `vector.setWidthPoint` (one point by `index`, or a new one at `t`; side widths in document units), `vector.setCorners` (radius and / or kind of anchors or paths), `vector.outlineStroke`, `vector.transform`, `vector.skew` (`ax`, `ay` degrees), `vector.distort` (the selection box's four new `corners`), `vector.envelope` (a warp `preset` with `bend`, `horizontal`, `vertical`, `orientation`; or a `mesh` of `rows` × `columns`, optionally with its `points`; or `topObject`, `release` or `expand`), `vector.delete`, `vector.boolean` (`live: true` for a live boolean), `vector.addEffect`, `vector.updateEffect` (parameters, `enabled`, `index`), `vector.removeEffect`, `vector.expandAppearance`, `vector.pathfinder`, `vector.blend`, `vector.blendOptions`, `vector.expandBlend`, `vector.releaseBlend`, `vector.replaceSpine`, `vector.shapeBuilderFaces`, `vector.shapeBuilder`, `vector.fillRegion`, `vector.align`, `vector.distribute`, `vector.arrange`, `vector.group`, `vector.ungroup`, `vector.deleteAnchors`, `vector.moveAnchor`, `vector.bendSegment`, `vector.join`, `vector.average`, `vector.removeRedundantPoints`, `vector.smooth`, `vector.cut`, `vector.knife`, `vector.erase`, `vector.setEditing`, `vector.setTool`, `vector.listFonts`, `vector.addText`, `vector.getText`, `vector.setText`, `vector.setTextStyle`, `vector.setParagraphStyle`, `vector.setTextFrame`, `vector.typeOnPath`, `vector.createOutlines`, `vector.listSymbols`, `vector.makeSymbol`, `vector.placeSymbol`, `vector.setInstanceOptions`, `vector.replaceSymbol`, `vector.detachInstance`, `vector.renameSymbol`, `vector.deleteSymbol`, `vector.editSymbol`, `vector.exitSymbolEdit`, `vector.listConstraints`, `vector.addConstraint`, `vector.removeConstraint`, `vector.setConstraintValue`, `vector.autoConstrain`, `vector.exportSvg` and `vector.importSvg`. Register them in a `CommandRegistry` and `createCommandToolProvider` exposes them as agent tools.
