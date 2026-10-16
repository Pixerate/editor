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

- A **path** has one or more subpaths (holes and compound shapes), a fill and stroke (any CSS colour, a gradient, or `null`), stroke width / caps / joins / dashes, a fill rule and opacity.
- An **anchor** has optional `in` / `out` handles (absolute document positions). A segment with no handles at either end is a straight line; otherwise it is a cubic Bézier. `type` is `corner`, `smooth` (handles in line) or `symmetric` (in line, equal length) and decides how the opposite handle follows when one is dragged.
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
| Pencil (N) | Freehand; the stroke is fitted to cubic Béziers. Lazy-mouse smoothing (`pencilSmoothing`) and shape recognition (`recognizeShapes`) are optional |
| Scissors (C) | Click a path: cuts it there (at an anchor when one is near). A closed path opens; an open one splits into two paths |
| Knife (K) | Drag across filled shapes: each stretch that crosses one from edge to edge cuts it, with no gap between the pieces. Cuts the selection, or with nothing selected every shape it crosses |
| Eraser (E) | Drag: rubs out a round stroke `eraserSize` wide. Filled shapes lose that area (pieces that come apart become separate paths), outlines are cut under it. Erases from the selection, or every path it reaches |
| Rectangle (R), Ellipse (O), Polygon (Y), Star (S), Line (L) | Drag out a shape (Shift: square / 45°, Alt: from the centre); returns to Select |

Other keys: Delete / Backspace, arrows (Shift = 10), Mod+Z / Mod+Shift+Z, Mod+A, Mod+D, Mod+G / Mod+Shift+G, Mod+J (Join) / Mod+Alt+J (Average), Mod+] / Mod+[ (Alt: to front / back), Mod+= / Mod+- / Mod+0, Space-drag or middle-drag to pan, Mod+wheel to zoom.

Every gesture is one undo step (`Move`, `Scale`, `Draw Rectangle`, `Add Point`, `Close Path`, …), recorded in the controller's `HistoryManager` (pass `history` to share one with the rest of the app). `Escape` during a drag puts everything back.

The selection box follows the selection's rotation when every selected node shares one (`state.selectionFrame.angle`); its resize handles, `scale` and `flip` act along those rotated axes, and `setRotation(degrees)` turns each node to an absolute angle. `state.selectionBounds` stays the axis-aligned box used by align and distribute.

Programmatic API, all undoable: `setRotation`, `addShape`, `addPath`, `addNode`, `updateNode`, `setStyle`, `removeNodes`, `translate`, `scale`, `rotate`, `flip`, `transform(matrix)`, `align`, `distribute`, `arrange`, `group`, `ungroup`, `duplicate`, `booleanOp('union' | 'subtract' | 'intersect' | 'exclude')`, `combine`, `breakApart`, `moveAnchor`, `moveHandle`, `convertAnchors`, `insertAnchorAt`, `deleteAnchors`, `setClosed`, `reversePaths`, `copy` / `cut` / `paste` (JSON text, or SVG markup on paste), `loadSvg`, `importSvg`, `setDocument`, `setArtboard`. Viewport: `zoomAt`, `zoomToFit`, `panBy`, `setViewport`, `screenToDocument`, `documentToScreen`.

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

`getVectorSceneRenderData(state)` returns the document as SVG-ready paths (with gradient defs) and a `transform` for the document layer; `getVectorOverlayRenderData(state)` returns the overlay in screen pixels: outlines, the selection box with its handles, anchors, handles, the marquee, the pen's rubber band, smart guide lines and labels (`guides`), the knife or eraser stroke being drawn (`toolStroke`), the pencil's lazy-mouse string (`pencilString`), the scissors cut point (`cutPoint`) and a status string. Draw the overlay outside the transformed layer so handles keep their size at any zoom. Scene nodes carry an SVG `transform` when rotated, and the selection box comes unrotated with a `transform` (`rotate(angle cx cy)`) to draw it in — handle `screen` positions are the true on-screen points. The bundled React and Svelte canvases are thin renderers over these two functions.

## SVG

```ts
import { parseVectorSvg, vectorDocumentToSvg } from "@pixerate/editor/vector";

const doc = parseVectorSvg(markup);        // DOM-free: path, rect, circle, ellipse, line, polyline, polygon, g,
                                           // linear / radial gradients, style attributes and transforms
const svg = vectorDocumentToSvg(doc);      // standalone SVG with <defs> for gradients
```

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

`<VectorCanvas>` (smart guides drawn in `guideColor`), `<VectorToolbar>` (with a snapping toggle, `showSnap`, and a path-editing group, `showPathEdit`: Join, Average, Cut at Points, Remove Redundant Points, Smooth, the Keep shape / Curvature / Shapes toggles, and the pencil smoothing and eraser size inputs while those tools are active) and `<VectorStylePanel>` can be used on their own; `useVectorEditor` / `useVectorEditorState` give the state.

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

`createVectorEditor(controllerOrOptions)` exposes the state reactively (call `destroy()` when done). `<VectorCanvas>` takes `guideColor` and `<VectorToolbar>` `showSnap` and `showPathEdit`, as in React. Both toolbars build the path-editing group from `VECTOR_PATH_ACTIONS` and `VECTOR_EDIT_TOGGLES`.

## Agent commands

`createVectorCommands(controller)` returns `vector.list`, `vector.select`, `vector.addShape`, `vector.addPath`, `vector.setStyle`, `vector.transform`, `vector.delete`, `vector.boolean`, `vector.align`, `vector.distribute`, `vector.arrange`, `vector.group`, `vector.ungroup`, `vector.deleteAnchors`, `vector.moveAnchor`, `vector.bendSegment`, `vector.join`, `vector.average`, `vector.removeRedundantPoints`, `vector.smooth`, `vector.cut`, `vector.knife`, `vector.erase`, `vector.setEditing`, `vector.setTool`, `vector.exportSvg` and `vector.importSvg`. Register them in a `CommandRegistry` and `createCommandToolProvider` exposes them as agent tools.
